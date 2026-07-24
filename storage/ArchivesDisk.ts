import fs from "fs";
import path from "path";
import { lazy } from "socket-function/src/caching";
import { runInfinitePoll } from "socket-function/src/batching";
import { sort, binarySearchBasic } from "socket-function/src/misc";
import { IArchives, ArchiveFileInfo, ArchivesConfig, ChangesAfterConfig, DelConfig, FindConfig, GetConfig, GetInfoConfig, SetConfig, assertValidLastModified } from "./IArchives";
import { filterChanges } from "./remoteStorage/remoteConfig";

// The base file-system IArchives: storage is one-to-one with the file system, every key is exactly one real file under <folder>/files, so the file system itself is the index. File handles are cached and reused, and closed once idle (see FileHandleCache). All operations on a file run in serial, so they can't collide with each other or with handle closing. Used as the disk synchronization source of BlobStore (see remoteStorage/blobStore.ts).

const HANDLE_IDLE_TIMEOUT = 1000 * 60;
const HANDLE_SWEEP_INTERVAL = 1000 * 15;
// Upload temp files are only garbage once they are clearly abandoned. Another process can share our folder (every deploy overlap does), so a fresh temp file may be ITS in-progress upload - deleting it would silently turn that upload into an empty file.
const UPLOAD_ABANDONED_AGE = 1000 * 60 * 60 * 24 * 3;

type HandleEntry = {
    filePath: string;
    handle: fs.promises.FileHandle;
    lastUse: number;
};

// Caches open file handles, closing them once idle for HANDLE_IDLE_TIMEOUT. Instead of one setTimeout per handle, a list sorted by last use is swept periodically (entries are moved via binary search on access, and lastUse values only increase, so touched entries append at the end). Also serializes operations per file: each operation only starts once the previous one on the same file finished, and a handle is never closed while an operation is pending on it.
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

export class ArchivesDisk implements IArchives {
    constructor(private folder: string) { }

    private filesDir = path.join(this.folder, "files");
    private uploadsDir = path.join(this.folder, "uploads");
    private handles = new FileHandleCache();
    private largeUploads = new Map<string, { tmpPath: string }>();
    private nextLargeUploadId = 1;

    public init = lazy(async () => {
        await fs.promises.mkdir(this.filesDir, { recursive: true });
        await fs.promises.mkdir(this.uploadsDir, { recursive: true });
        let cutoff = Date.now() - UPLOAD_ABANDONED_AGE;
        for (let file of await fs.promises.readdir(this.uploadsDir)) {
            let uploadPath = path.join(this.uploadsDir, file);
            // The mtime advances on every append, so an active upload (even another process's) always looks fresh
            let stats = await statOrUndefined(uploadPath);
            if (!stats || stats.mtimeMs > cutoff) continue;
            console.log(`Deleting abandoned upload temp file ${uploadPath} (last written ${new Date(stats.mtimeMs).toISOString()})`);
            await fs.promises.unlink(uploadPath);
        }
    });

    public getDebugName() {
        return `disk ${this.folder}`;
    }

    public async getConfig(): Promise<ArchivesConfig> {
        return {};
    }

    public async getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]> {
        // No native change feed - a full listing filtered in memory (see the scanning note in BlobStore.scanSource for why the listing itself takes no filters)
        return filterChanges(await this.findInfo(""), config);
    }

    public async hasWriteAccess(): Promise<boolean> {
        return true;
    }

    private filePath(key: string): string {
        let result = path.join(this.filesDir, key);
        if (!result.startsWith(this.filesDir + path.sep)) {
            throw new Error(`Invalid key ${JSON.stringify(key.slice(0, 200))}, it escapes the store folder`);
        }
        return result;
    }

    // forceSetImmutable is accepted and needs no handling: disk sources are never immutable, and the older-write no-op below already gives synchronization its only-take-the-latest semantics
    public async set(key: string, data: Buffer, config?: SetConfig): Promise<string> {
        if (!data.length) {
            throw new Error(`set was called with an empty buffer for ${JSON.stringify(key)} on ${this.getDebugName()}: an empty file IS a deletion in this system and would read back as missing - call del instead`);
        }
        await this.init();
        let lastModified = config?.lastModified;
        if (lastModified) {
            assertValidLastModified(lastModified);
        }
        let filePath = this.filePath(key);
        await this.handles.run(filePath, async () => {
            if (lastModified) {
                let existing = await statOrUndefined(filePath);
                // An older write never overwrites a newer one (see IArchives.set)
                if (existing && lastModified < existing.mtimeMs) return;
            }
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            let handle = await this.handles.getHandle(filePath, fs.constants.O_RDWR | fs.constants.O_CREAT);
            await handle.truncate(0);
            await handle.write(data, 0, data.length, 0);
            if (lastModified) {
                await handle.utimes(new Date(lastModified), new Date(lastModified));
            }
        });
        return key;
    }

    // config is accepted and ignored: a disk deletion is a physical remove (no tombstone to stamp - BlobStore's index carries the tombstone for disk sources)
    public async del(key: string, config?: DelConfig): Promise<void> {
        await this.init();
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

    public async get(key: string, config?: GetConfig): Promise<Buffer | undefined> {
        let result = await this.get2(key, config);
        return result && result.data || undefined;
    }

    public async get2(key: string, config?: GetConfig): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        await this.init();
        let range = config?.range;
        let filePath = this.filePath(key);
        return await this.handles.run(filePath, async () => {
            let handle: fs.promises.FileHandle;
            try {
                handle = await this.handles.getHandle(filePath, fs.constants.O_RDWR);
            } catch (e: any) {
                if (e.code === "ENOENT") return undefined;
                throw e;
            }
            let stats = await handle.stat();
            let size = stats.size;
            // A size-0 file is a tombstone (an empty file IS a missing file) - absent, unless the caller asked for tombstones. Ranged reads of a REAL file can still legitimately return no bytes (range past EOF, below).
            if (!size && !config?.includeTombstones) return undefined;
            let start = range && Math.min(range.start, size) || 0;
            let end = range && Math.min(range.end, size) || size;
            if (end <= start) return { data: Buffer.alloc(0), writeTime: stats.mtimeMs, size };
            let buffer = Buffer.alloc(end - start);
            let { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
            if (bytesRead !== buffer.length) {
                throw new Error(`Expected ${buffer.length} bytes at ${filePath}:${start}, read ${bytesRead}`);
            }
            return { data: buffer, writeTime: stats.mtimeMs, size };
        });
    }

    public async getInfo(key: string, config?: GetInfoConfig): Promise<{ writeTime: number; size: number } | undefined> {
        await this.init();
        let filePath = this.filePath(key);
        return await this.handles.run(filePath, async () => {
            let stats = await statOrUndefined(filePath);
            if (!stats || !stats.isFile()) return undefined;
            if (!stats.size && !config?.includeTombstones) return undefined;
            return { writeTime: stats.mtimeMs, size: stats.size };
        });
    }

    public async find(prefix: string, config?: FindConfig): Promise<string[]> {
        return (await this.findInfo(prefix, config)).map(x => x.path);
    }

    public async findInfo(prefix: string, config?: FindConfig): Promise<ArchiveFileInfo[]> {
        await this.init();
        let infos = new Map<string, ArchiveFileInfo>();
        await this.collectFiles("", prefix, infos);
        let files = Array.from(infos.values());
        files = applyFindInfoShape(files, prefix, config);
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
            let stats = await statOrUndefined(path.join(this.filesDir, relPath));
            // Deleted while we were walking
            if (!stats) continue;
            infos.set(relPath, { path: relPath, createTime: stats.mtimeMs, size: stats.size });
        }
    }

    public async setLargeFile(config: { path: string; lastModified?: number; getNextData(): Promise<Buffer | undefined> }): Promise<void> {
        let id = await this.startLargeUpload();
        try {
            while (true) {
                let data = await config.getNextData();
                if (!data) break;
                await this.appendLargeUpload(id, data);
            }
            await this.finishLargeUpload(id, config.path, config.lastModified);
        } catch (e) {
            await this.cancelLargeUpload(id);
            throw e;
        }
    }

    // Large files stream into their own file under uploads/, then move into place on finish. No handle is opened until the first append actually happens.
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
    public async finishLargeUpload(id: string, key: string, lastModified?: number): Promise<void> {
        let upload = this.largeUploads.get(id);
        if (!upload) throw new Error(`Unknown large upload ${id}`);
        if (lastModified) {
            assertValidLastModified(lastModified);
        }
        const tmpPath = upload.tmpPath;
        this.largeUploads.delete(id);
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
                // Either nothing was ever appended, or the temp file was destroyed under us - both must fail loudly. Materializing an empty file here (the old behavior) silently turned the upload into a DELETION, since an empty file IS a missing file in this system.
                throw new Error(`Large upload of ${JSON.stringify(key)} has no data: the upload temp file ${tmpPath} does not exist. Either no data was ever appended (empty files are forbidden - they read back as deletions; use del to delete) or the temp file was removed while the upload was running.`);
            }
            // The rename preserves the temp file's mtime, which is just when the last append happened - the logical write time has to be stamped explicitly (it is the metadata scans order everything by)
            if (lastModified) {
                await fs.promises.utimes(filePath, new Date(lastModified), new Date(lastModified));
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

    public async getURL(path: string): Promise<string> {
        throw new Error(`getURL is not supported for disk archives (${this.getDebugName()}, path ${path})`);
    }
}

async function statOrUndefined(filePath: string): Promise<fs.Stats | undefined> {
    try {
        return await fs.promises.stat(filePath);
    } catch (e: any) {
        if (e.code === "ENOENT") return undefined;
        throw e;
    }
}

// The folders/shallow post-processing shared by findInfo implementations that list flat files (used by ArchivesDisk on the raw disk walk, and by BlobStore on its index).
export function applyFindInfoShape(files: ArchiveFileInfo[], prefix: string, config?: FindConfig): ArchiveFileInfo[] {
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
        return Array.from(folders.values());
    }
    if (config?.shallow) {
        return files.filter(file => !file.path.slice(prefix.length).includes("/"));
    }
    return files;
}
