import fs from "fs";
import path from "path";
import { lazy } from "socket-function/src/caching";
import { runInSerial, runInfinitePoll } from "socket-function/src/batching";
import { timeInMinute, sort } from "socket-function/src/misc";
import { formatNumber } from "socket-function/src/formatting/format";
import { TransactionStorage } from "../TransactionStorage";
import { JSONStorage } from "../JSONStorage";
import { getFileStorageNested2 } from "../FileFolderAPI";
import { ArchiveFileInfo } from "../IArchives";

// Disk engine for the remote storage server. Files are packed into large append-only blob files
// (instead of one file on disk per stored file), with a transaction-log index mapping
// key -> (blob, offset, length). This keeps us efficient with many small files and scales to
// terabytes: reads are single pread calls, writes are appends, and deleted space is reclaimed by
// compacting blobs that are mostly dead.

// Roll to a new blob file once the current one reaches this size
const MAX_BLOB_SIZE = 4 * 1024 * 1024 * 1024;
// Whole-file memory cache (only files up to MEMORY_CACHE_MAX_FILE are cached)
const MEMORY_CACHE_BYTES = 256 * 1024 * 1024;
const MEMORY_CACHE_MAX_FILE = 16 * 1024 * 1024;
export const DEFAULT_FAST_WRITE_DELAY = timeInMinute * 5;
const FAST_FLUSH_POLL = 1000 * 15;
const COMPACTION_INTERVAL = timeInMinute * 10;
// Compact a blob once this fraction of its bytes are dead (deleted/overwritten)
const COMPACTION_DEAD_FRACTION = 0.5;
const MAX_OPEN_BLOBS = 64;

type IndexEntry = {
    // Blob file name
    f: string;
    // Offset + length within the blob
    o: number;
    l: number;
    // Write time
    t: number;
};

export type WriteConfig = {
    // Resolve once the write is in memory; flush to disk after writeDelay, coalescing writes to
    // the same key (only the latest is written). Data is lost if the process crashes first.
    fast?: boolean;
    writeDelay?: number;
};

type OverlayEntry = {
    // undefined data means a pending delete
    data: Buffer | undefined;
    t: number;
    flushAt: number;
};

class ByteLRU {
    private map = new Map<string, Buffer>();
    private bytes = 0;
    constructor(private budget: number, private maxEntry: number) { }
    public get(key: string): Buffer | undefined {
        let value = this.map.get(key);
        if (value) {
            this.map.delete(key);
            this.map.set(key, value);
        }
        return value;
    }
    public set(key: string, value: Buffer) {
        this.delete(key);
        if (value.length > this.maxEntry) return;
        this.map.set(key, value);
        this.bytes += value.length;
        while (this.bytes > this.budget && this.map.size > 0) {
            let oldest = this.map.keys().next().value;
            if (oldest === undefined) break;
            this.delete(oldest);
        }
    }
    public delete(key: string) {
        let existing = this.map.get(key);
        if (!existing) return;
        this.bytes -= existing.length;
        this.map.delete(key);
    }
}

export class BlobStore {
    constructor(private folder: string) { }

    private memCache = new ByteLRU(MEMORY_CACHE_BYTES, MEMORY_CACHE_MAX_FILE);
    private overlay = new Map<string, OverlayEntry>();
    private writeQueue = runInSerial(async (fnc: () => Promise<void>) => fnc());
    private openBlobs = new Map<string, Promise<fs.promises.FileHandle>>();
    private largeUploads = new Map<string, { fd: fs.promises.FileHandle; tmpPath: string; size: number }>();
    private nextLargeUploadId = 1;

    private currentBlobNumber = 0;
    private currentBlobOffset = 0;
    private currentBlobFd: fs.promises.FileHandle | undefined;

    private index!: JSONStorage<IndexEntry>;
    // Dead (deleted/overwritten) byte count per blob file, for compaction
    private deadBytes!: JSONStorage<number>;

    private blobsDir = path.join(this.folder, "blobs");

    public init = lazy(async () => {
        fs.mkdirSync(this.blobsDir, { recursive: true });
        let root = await getFileStorageNested2(path.resolve(this.folder));
        let indexRaw = await root.folder.getStorage("index");
        this.index = new JSONStorage<IndexEntry>(new TransactionStorage(indexRaw, "blobStoreIndex"));
        let metaRaw = await root.folder.getStorage("meta");
        this.deadBytes = new JSONStorage<number>(new TransactionStorage(metaRaw, "blobStoreDeadBytes"));

        for (let file of fs.readdirSync(this.blobsDir)) {
            let match = /^blob_(\d+)\.bin$/.exec(file);
            if (!match) continue;
            this.currentBlobNumber = Math.max(this.currentBlobNumber, +match[1]);
        }
        if (this.currentBlobNumber > 0) {
            this.currentBlobOffset = fs.statSync(path.join(this.blobsDir, this.blobName(this.currentBlobNumber))).size;
        }

        runInfinitePoll(FAST_FLUSH_POLL, () => this.flushOverlay());
        runInfinitePoll(COMPACTION_INTERVAL, () => this.compact());
    });

    private blobName(n: number) {
        return `blob_${String(n).padStart(6, "0")}.bin`;
    }
    private blobPath(name: string) {
        return path.join(this.blobsDir, name);
    }

    private async getBlobHandle(name: string): Promise<fs.promises.FileHandle> {
        let cached = this.openBlobs.get(name);
        if (cached) {
            // Re-insert for LRU ordering
            this.openBlobs.delete(name);
            this.openBlobs.set(name, cached);
            return cached;
        }
        let handle = fs.promises.open(this.blobPath(name), "r");
        this.openBlobs.set(name, handle);
        while (this.openBlobs.size > MAX_OPEN_BLOBS) {
            let oldest = this.openBlobs.keys().next().value;
            if (oldest === undefined) break;
            let oldHandle = this.openBlobs.get(oldest);
            this.openBlobs.delete(oldest);
            void oldHandle?.then(h => h.close()).catch(() => { });
        }
        return handle;
    }
    private async closeBlobHandle(name: string) {
        let handle = this.openBlobs.get(name);
        if (!handle) return;
        this.openBlobs.delete(name);
        await handle.then(h => h.close()).catch(() => { });
    }

    private async addDeadBytes(entry: IndexEntry) {
        // Large files get a dedicated blob file, so on delete we can unlink it immediately
        if (entry.f.startsWith("large_")) {
            await this.closeBlobHandle(entry.f);
            await fs.promises.unlink(this.blobPath(entry.f)).catch(() => { });
            return;
        }
        let dead = await this.deadBytes.get(entry.f) || 0;
        await this.deadBytes.set(entry.f, dead + entry.l);
    }

    // Appends data to the current blob file, returning where it landed
    private async appendData(data: Buffer): Promise<{ f: string; o: number; l: number }> {
        let result: { f: string; o: number; l: number } | undefined;
        await this.writeQueue(async () => {
            if (!this.currentBlobFd || this.currentBlobOffset >= MAX_BLOB_SIZE) {
                if (this.currentBlobFd) {
                    await this.currentBlobFd.close();
                    this.currentBlobFd = undefined;
                }
                this.currentBlobNumber++;
                this.currentBlobOffset = 0;
            }
            if (!this.currentBlobFd) {
                this.currentBlobFd = await fs.promises.open(this.blobPath(this.blobName(this.currentBlobNumber)), "a");
                this.currentBlobOffset = (await this.currentBlobFd.stat()).size;
            }
            let offset = this.currentBlobOffset;
            await this.currentBlobFd.write(data, 0, data.length);
            this.currentBlobOffset += data.length;
            result = { f: this.blobName(this.currentBlobNumber), o: offset, l: data.length };
        });
        if (!result) throw new Error(`Append did not run, this should be impossible`);
        return result;
    }

    private async setIndexEntry(key: string, entry: IndexEntry) {
        let prev = await this.index.get(key);
        await this.index.set(key, entry);
        if (prev) {
            await this.addDeadBytes(prev);
        }
    }

    public async set(key: string, data: Buffer, config?: WriteConfig): Promise<void> {
        await this.init();
        this.memCache.set(key, data);
        if (config?.fast) {
            let writeDelay = config.writeDelay || DEFAULT_FAST_WRITE_DELAY;
            this.overlay.set(key, { data, t: Date.now(), flushAt: Date.now() + writeDelay });
            return;
        }
        this.overlay.delete(key);
        let location = await this.appendData(data);
        await this.setIndexEntry(key, { ...location, t: Date.now() });
    }

    public async del(key: string, config?: WriteConfig): Promise<void> {
        await this.init();
        this.memCache.delete(key);
        if (config?.fast) {
            let writeDelay = config.writeDelay || DEFAULT_FAST_WRITE_DELAY;
            this.overlay.set(key, { data: undefined, t: Date.now(), flushAt: Date.now() + writeDelay });
            return;
        }
        this.overlay.delete(key);
        let prev = await this.index.get(key);
        if (!prev) return;
        await this.index.remove(key);
        await this.addDeadBytes(prev);
    }

    public async get(key: string, range?: { start: number; end: number }): Promise<Buffer | undefined> {
        await this.init();
        let overlayEntry = this.overlay.get(key);
        if (overlayEntry) {
            if (!overlayEntry.data) return undefined;
            if (!range) return overlayEntry.data;
            return overlayEntry.data.subarray(Math.min(range.start, overlayEntry.data.length), Math.min(range.end, overlayEntry.data.length));
        }
        let cached = this.memCache.get(key);
        if (cached) {
            if (!range) return cached;
            return cached.subarray(Math.min(range.start, cached.length), Math.min(range.end, cached.length));
        }
        let entry = await this.index.get(key);
        if (!entry) return undefined;
        let start = range && Math.min(range.start, entry.l) || 0;
        let end = range && Math.min(range.end, entry.l) || entry.l;
        if (end <= start) return Buffer.alloc(0);
        let handle = await this.getBlobHandle(entry.f);
        let buffer = Buffer.alloc(end - start);
        let { bytesRead } = await handle.read(buffer, 0, buffer.length, entry.o + start);
        if (bytesRead !== buffer.length) {
            throw new Error(`Expected ${buffer.length} bytes at ${entry.f}:${entry.o + start} for ${key}, read ${bytesRead}`);
        }
        if (!range && buffer.length <= MEMORY_CACHE_MAX_FILE) {
            this.memCache.set(key, buffer);
        }
        return buffer;
    }

    public async getInfo(key: string): Promise<{ writeTime: number; size: number } | undefined> {
        await this.init();
        let overlayEntry = this.overlay.get(key);
        if (overlayEntry) {
            if (!overlayEntry.data) return undefined;
            return { writeTime: overlayEntry.t, size: overlayEntry.data.length };
        }
        let entry = await this.index.get(key);
        if (!entry) return undefined;
        return { writeTime: entry.t, size: entry.l };
    }

    public async findInfo(prefix: string, config?: { shallow?: boolean; type?: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        await this.init();
        let infos = new Map<string, ArchiveFileInfo>();
        for (let key of await this.index.getKeys()) {
            if (!key.startsWith(prefix)) continue;
            if (this.overlay.has(key)) continue;
            let entry = await this.index.get(key);
            if (!entry) continue;
            infos.set(key, { path: key, createTime: entry.t, size: entry.l });
        }
        for (let [key, overlayEntry] of this.overlay) {
            if (!key.startsWith(prefix)) continue;
            if (!overlayEntry.data) continue;
            infos.set(key, { path: key, createTime: overlayEntry.t, size: overlayEntry.data.length });
        }
        let files = Array.from(infos.values());
        if (config?.type === "folders") {
            let folders = new Map<string, ArchiveFileInfo>();
            for (let file of files) {
                let rest = file.path.slice(prefix.length);
                let restParts = rest.split("/");
                if (restParts.length < 2) continue;
                let folder: string;
                if (config.shallow) {
                    folder = prefix + restParts[0];
                } else {
                    folder = file.path.split("/").slice(0, -1).join("/");
                }
                folders.set(folder, { path: folder, createTime: file.createTime, size: file.size });
            }
            files = Array.from(folders.values());
        } else if (config?.shallow) {
            files = files.filter(file => !file.path.slice(prefix.length).includes("/"));
        }
        sort(files, x => x.path);
        return files;
    }

    // Large files stream into their own dedicated blob file, so concurrent small writes don't
    // interleave into the middle of them.
    public async startLargeUpload(): Promise<string> {
        await this.init();
        let id = `${Date.now()}_${this.nextLargeUploadId++}`;
        let tmpPath = path.join(this.blobsDir, `upload_${id}.tmp`);
        let fd = await fs.promises.open(tmpPath, "w");
        this.largeUploads.set(id, { fd, tmpPath, size: 0 });
        return id;
    }
    public async appendLargeUpload(id: string, data: Buffer): Promise<void> {
        let upload = this.largeUploads.get(id);
        if (!upload) throw new Error(`Unknown large upload ${id}`);
        await upload.fd.write(data, 0, data.length);
        upload.size += data.length;
    }
    public async finishLargeUpload(id: string, key: string): Promise<void> {
        let upload = this.largeUploads.get(id);
        if (!upload) throw new Error(`Unknown large upload ${id}`);
        this.largeUploads.delete(id);
        await upload.fd.close();
        let blobName = `large_${id}.bin`;
        await fs.promises.rename(upload.tmpPath, this.blobPath(blobName));
        this.memCache.delete(key);
        this.overlay.delete(key);
        await this.setIndexEntry(key, { f: blobName, o: 0, l: upload.size, t: Date.now() });
    }
    public async cancelLargeUpload(id: string): Promise<void> {
        let upload = this.largeUploads.get(id);
        if (!upload) return;
        this.largeUploads.delete(id);
        await upload.fd.close();
        await fs.promises.unlink(upload.tmpPath).catch(() => { });
    }

    private async flushOverlay(): Promise<void> {
        let now = Date.now();
        for (let [key, entry] of this.overlay) {
            if (entry.flushAt > now) continue;
            if (entry.data) {
                let location = await this.appendData(entry.data);
                await this.setIndexEntry(key, { ...location, t: entry.t });
            } else {
                let prev = await this.index.get(key);
                if (prev) {
                    await this.index.remove(key);
                    await this.addDeadBytes(prev);
                }
            }
            // Only remove if it wasn't overwritten while we were flushing
            if (this.overlay.get(key) === entry) {
                this.overlay.delete(key);
            }
        }
    }

    private async compact(): Promise<void> {
        let currentBlob = this.blobName(this.currentBlobNumber);
        for (let blobName of await this.deadBytes.getKeys()) {
            if (blobName === currentBlob) continue;
            let dead = await this.deadBytes.get(blobName) || 0;
            let blobPath = this.blobPath(blobName);
            let size = 0;
            try {
                size = fs.statSync(blobPath).size;
            } catch {
                await this.deadBytes.remove(blobName);
                continue;
            }
            if (dead < size * COMPACTION_DEAD_FRACTION) continue;

            console.log(`Compacting blob ${blobName} (${formatNumber(dead)}B dead of ${formatNumber(size)}B)`);
            for (let key of await this.index.getKeys()) {
                let entry = await this.index.get(key);
                if (!entry || entry.f !== blobName) continue;
                let data = await this.get(key);
                if (!data) continue;
                let location = await this.appendData(data);
                // Only move it if it wasn't rewritten while we were reading
                let latest = await this.index.get(key);
                if (latest && latest.f === entry.f && latest.o === entry.o) {
                    await this.index.set(key, { ...location, t: latest.t });
                } else {
                    // Our copy is stale, so its bytes are immediately dead
                    await this.deadBytes.set(location.f, (await this.deadBytes.get(location.f) || 0) + location.l);
                }
            }
            await this.closeBlobHandle(blobName);
            await fs.promises.unlink(blobPath).catch(() => { });
            await this.deadBytes.remove(blobName);
        }
    }
}
