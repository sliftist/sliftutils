import fs from "fs";
import path from "path";
import { lazy } from "socket-function/src/caching";
import { runInfinitePoll } from "socket-function/src/batching";
import { timeInMinute, sort, binarySearchBasic } from "socket-function/src/misc";
import { ArchiveFileInfo } from "../IArchives";

// Disk engine for the remote storage server. Storage is one-to-one with the file system: every
// key is exactly one file on disk (under files/), so the file system itself is the index. File
// handles are cached and reused, and closed once idle (see FileHandleCache). All operations on a
// file run in serial, so they can't collide with each other or with handle closing.

export const DEFAULT_FAST_WRITE_DELAY = timeInMinute * 5;
const FAST_FLUSH_POLL = 1000 * 15;
const HANDLE_IDLE_TIMEOUT = 1000 * 60;
const HANDLE_SWEEP_INTERVAL = 1000 * 15;

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

type HandleEntry = {
    filePath: string;
    handle: fs.promises.FileHandle;
    lastUse: number;
};

// Caches open file handles, closing them once idle for HANDLE_IDLE_TIMEOUT. Instead of one
// setTimeout per handle, a list sorted by last use is swept periodically (entries are moved via
// binary search on access, and lastUse values only increase, so touched entries append at the
// end). Also serializes operations per file: each operation only starts once the previous one on
// the same file finished, and a handle is never closed while an operation is pending on it.
class FileHandleCache {
    private entries = new Map<string, HandleEntry>();
    // Sorted by lastUse ascending (least recently used first)
    private lru: HandleEntry[] = [];
    private pending = new Map<string, Promise<void>>();

    constructor() {
        runInfinitePoll(HANDLE_SWEEP_INTERVAL, () => this.sweep());
    }

    // Runs fnc after every previously scheduled operation on filePath has finished
    public run<T>(filePath: string, fnc: () => Promise<T>): Promise<T> {
        let prev = this.pending.get(filePath) || Promise.resolve();
        let result = prev.then(fnc);
        // The pending chain must never reject, or one failed operation would poison all later ones
        let last = result.then(() => { }, () => { });
        this.pending.set(filePath, last);
        void last.then(() => {
            // If we're still the last pending operation on this file, clear ourselves
            if (this.pending.get(filePath) === last) {
                this.pending.delete(filePath);
            }
        });
        return result;
    }

    // Only call inside run() for the same filePath (so opens can't collide with closes)
    public async getHandle(filePath: string, flags: number): Promise<fs.promises.FileHandle> {
        let entry = this.entries.get(filePath);
        if (entry) {
            this.removeFromLRU(entry);
            entry.lastUse = Date.now();
            this.lru.push(entry);
            return entry.handle;
        }
        let handle = await fs.promises.open(filePath, flags);
        entry = { filePath, handle, lastUse: Date.now() };
        this.entries.set(filePath, entry);
        this.lru.push(entry);
        return handle;
    }

    // Only call inside run() for the same filePath
    public async closeNow(filePath: string): Promise<void> {
        let entry = this.entries.get(filePath);
        if (!entry) return;
        this.entries.delete(filePath);
        this.removeFromLRU(entry);
        await entry.handle.close();
    }

    private removeFromLRU(entry: HandleEntry) {
        let index = binarySearchBasic(this.lru, x => x.lastUse, entry.lastUse);
        if (index < 0) return;
        // Multiple entries can share a lastUse, so scan for the exact one
        while (index < this.lru.length && this.lru[index].lastUse === entry.lastUse) {
            if (this.lru[index] === entry) {
                this.lru.splice(index, 1);
                return;
            }
            index++;
        }
    }

    private async sweep(): Promise<void> {
        let cutoff = Date.now() - HANDLE_IDLE_TIMEOUT;
        let index = 0;
        while (index < this.lru.length && this.lru[index].lastUse <= cutoff) {
            let entry = this.lru[index];
            // Can't close a handle with a pending operation; it'll be swept after it finishes
            if (this.pending.has(entry.filePath)) {
                index++;
                continue;
            }
            this.lru.splice(index, 1);
            this.entries.delete(entry.filePath);
            await entry.handle.close();
        }
    }
}

export class BlobStore {
    constructor(private folder: string) { }

    private filesDir = path.join(this.folder, "files");
    private uploadsDir = path.join(this.folder, "uploads");
    private handles = new FileHandleCache();
    private overlay = new Map<string, OverlayEntry>();
    private largeUploads = new Map<string, { tmpPath: string }>();
    private nextLargeUploadId = 1;

    public init = lazy(async () => {
        await fs.promises.mkdir(this.filesDir, { recursive: true });
        await fs.promises.mkdir(this.uploadsDir, { recursive: true });
        // Uploads don't survive restarts (the uploader streams into them), so old ones are garbage
        for (let file of await fs.promises.readdir(this.uploadsDir)) {
            await fs.promises.unlink(path.join(this.uploadsDir, file));
        }
        runInfinitePoll(FAST_FLUSH_POLL, () => this.flushOverlay());
    });

    private filePath(key: string): string {
        let result = path.join(this.filesDir, key);
        if (!result.startsWith(this.filesDir + path.sep)) {
            throw new Error(`Invalid key ${JSON.stringify(key.slice(0, 200))}, it escapes the store folder`);
        }
        return result;
    }

    public async set(key: string, data: Buffer, config?: WriteConfig): Promise<void> {
        await this.init();
        if (config?.fast) {
            let writeDelay = config.writeDelay || DEFAULT_FAST_WRITE_DELAY;
            this.overlay.set(key, { data, t: Date.now(), flushAt: Date.now() + writeDelay });
            return;
        }
        this.overlay.delete(key);
        await this.writeToDisk(key, data);
    }

    private async writeToDisk(key: string, data: Buffer, writeTime?: number): Promise<void> {
        let filePath = this.filePath(key);
        await this.handles.run(filePath, async () => {
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            let handle = await this.handles.getHandle(filePath, fs.constants.O_RDWR | fs.constants.O_CREAT);
            await handle.truncate(0);
            await handle.write(data, 0, data.length, 0);
            // Delayed (fast) writes keep the time the write actually happened
            if (writeTime) {
                await handle.utimes(new Date(writeTime), new Date(writeTime));
            }
        });
    }

    public async del(key: string, config?: WriteConfig): Promise<void> {
        await this.init();
        if (config?.fast) {
            let writeDelay = config.writeDelay || DEFAULT_FAST_WRITE_DELAY;
            this.overlay.set(key, { data: undefined, t: Date.now(), flushAt: Date.now() + writeDelay });
            return;
        }
        this.overlay.delete(key);
        await this.deleteFromDisk(key);
    }

    private async deleteFromDisk(key: string): Promise<void> {
        let filePath = this.filePath(key);
        await this.handles.run(filePath, async () => {
            await this.handles.closeNow(filePath);
            try {
                await fs.promises.unlink(filePath);
            } catch (e: any) {
                if (e.code !== "ENOENT") throw e;
            }
        });
    }

    public async get(key: string, range?: { start: number; end: number }): Promise<Buffer | undefined> {
        await this.init();
        let overlayEntry = this.overlay.get(key);
        if (overlayEntry) {
            if (!overlayEntry.data) return undefined;
            let data = overlayEntry.data;
            if (!range) return data;
            return data.subarray(Math.min(range.start, data.length), Math.min(range.end, data.length));
        }
        let filePath = this.filePath(key);
        return await this.handles.run(filePath, async () => {
            let handle: fs.promises.FileHandle;
            try {
                handle = await this.handles.getHandle(filePath, fs.constants.O_RDWR);
            } catch (e: any) {
                if (e.code === "ENOENT") return undefined;
                throw e;
            }
            let size = (await handle.stat()).size;
            let start = range && Math.min(range.start, size) || 0;
            let end = range && Math.min(range.end, size) || size;
            if (end <= start) return Buffer.alloc(0);
            let buffer = Buffer.alloc(end - start);
            let { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
            if (bytesRead !== buffer.length) {
                throw new Error(`Expected ${buffer.length} bytes at ${filePath}:${start}, read ${bytesRead}`);
            }
            return buffer;
        });
    }

    public async getInfo(key: string): Promise<{ writeTime: number; size: number } | undefined> {
        await this.init();
        let overlayEntry = this.overlay.get(key);
        if (overlayEntry) {
            if (!overlayEntry.data) return undefined;
            return { writeTime: overlayEntry.t, size: overlayEntry.data.length };
        }
        let filePath = this.filePath(key);
        return await this.handles.run(filePath, async () => {
            try {
                let stats = await fs.promises.stat(filePath);
                if (!stats.isFile()) return undefined;
                return { writeTime: stats.mtimeMs, size: stats.size };
            } catch (e: any) {
                if (e.code === "ENOENT") return undefined;
                throw e;
            }
        });
    }

    public async findInfo(prefix: string, config?: { shallow?: boolean; type?: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        await this.init();
        let infos = new Map<string, ArchiveFileInfo>();
        await this.collectFiles("", prefix, infos);
        for (let [key, overlayEntry] of this.overlay) {
            if (!key.startsWith(prefix)) continue;
            if (!overlayEntry.data) {
                infos.delete(key);
                continue;
            }
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

    // relDir is "" or ends with "/". Only descends into directories that can still match the prefix.
    private async collectFiles(relDir: string, prefix: string, infos: Map<string, ArchiveFileInfo>): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(path.join(this.filesDir, relDir), { withFileTypes: true });
        } catch (e: any) {
            if (e.code === "ENOENT") return;
            throw e;
        }
        for (let entry of entries) {
            let relPath = relDir + entry.name;
            if (entry.isDirectory()) {
                let dirPath = relPath + "/";
                if (dirPath.startsWith(prefix) || prefix.startsWith(dirPath)) {
                    await this.collectFiles(dirPath, prefix, infos);
                }
                continue;
            }
            if (!entry.isFile()) continue;
            if (!relPath.startsWith(prefix)) continue;
            try {
                let stats = await fs.promises.stat(path.join(this.filesDir, relPath));
                infos.set(relPath, { path: relPath, createTime: stats.mtimeMs, size: stats.size });
            } catch (e: any) {
                // Deleted while we were walking
                if (e.code !== "ENOENT") throw e;
            }
        }
    }

    // Large files stream into their own file under uploads/, then move into place on finish. No
    // handle is opened until the first append actually happens.
    public async startLargeUpload(): Promise<string> {
        await this.init();
        let id = `${Date.now()}_${this.nextLargeUploadId++}`;
        this.largeUploads.set(id, { tmpPath: path.join(this.uploadsDir, `upload_${id}.tmp`) });
        return id;
    }
    public async appendLargeUpload(id: string, data: Buffer): Promise<void> {
        let upload = this.largeUploads.get(id);
        if (!upload) throw new Error(`Unknown large upload ${id}`);
        const tmpPath = upload.tmpPath;
        await this.handles.run(tmpPath, async () => {
            let handle = await this.handles.getHandle(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND);
            await handle.write(data, 0, data.length);
        });
    }
    public async finishLargeUpload(id: string, key: string): Promise<void> {
        let upload = this.largeUploads.get(id);
        if (!upload) throw new Error(`Unknown large upload ${id}`);
        const tmpPath = upload.tmpPath;
        this.largeUploads.delete(id);
        this.overlay.delete(key);
        let filePath = this.filePath(key);
        await this.handles.run(tmpPath, () => this.handles.closeNow(tmpPath));
        await this.handles.run(filePath, async () => {
            // Close any cached handle to the file we're replacing, so later reads reopen the new file
            await this.handles.closeNow(filePath);
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            try {
                await fs.promises.rename(tmpPath, filePath);
            } catch (e: any) {
                if (e.code !== "ENOENT") throw e;
                // Nothing was ever appended, so the upload file was never created
                await fs.promises.writeFile(filePath, Buffer.alloc(0));
            }
        });
    }
    public async cancelLargeUpload(id: string): Promise<void> {
        let upload = this.largeUploads.get(id);
        if (!upload) return;
        const tmpPath = upload.tmpPath;
        this.largeUploads.delete(id);
        await this.handles.run(tmpPath, async () => {
            await this.handles.closeNow(tmpPath);
            try {
                await fs.promises.unlink(tmpPath);
            } catch (e: any) {
                if (e.code !== "ENOENT") throw e;
            }
        });
    }

    private async flushOverlay(): Promise<void> {
        let now = Date.now();
        for (let [key, entry] of this.overlay) {
            if (entry.flushAt > now) continue;
            if (entry.data) {
                await this.writeToDisk(key, entry.data, entry.t);
            } else {
                await this.deleteFromDisk(key);
            }
            // Only remove if it wasn't overwritten while we were flushing
            if (this.overlay.get(key) === entry) {
                this.overlay.delete(key);
            }
        }
    }
}
