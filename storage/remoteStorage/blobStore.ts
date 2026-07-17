import path from "path";
import { lazy } from "socket-function/src/caching";
import { runInfinitePoll, delay } from "socket-function/src/batching";
import { timeInMinute, sort, promiseObj } from "socket-function/src/misc";
import {
    IArchives, ArchiveFileInfo, ArchivesSource, ArchivesSyncStatus, assertValidLastModified,
} from "../IArchives";
import { ArchivesDisk, applyFindInfoShape } from "../ArchivesDisk";
import { BulkDatabaseBase, noopReactiveDeps } from "../BulkDatabase2/BulkDatabaseBase";
import { wrapHandle, NodeJSDirectoryHandleWrapper, DirectoryWrapper } from "../FileFolderAPI";

// The storage engine of the remote storage server. Data lives in synchronization sources (at
// minimum an ArchivesDisk, the local disk); BlobStore keeps an index of every file (path, last
// modified time, size, and which source currently holds the data) in a BulkDatabase2, and
// synchronizes the index from all sources (see ArchivesSource / SyncOptions in IArchives.ts).
// Every startup fully rescans each source's metadata, so the index self-heals; the file with the
// highest write time wins across all sources, so multiple sources need no stacking order.

export const DEFAULT_FAST_WRITE_DELAY = timeInMinute * 5;
const FAST_FLUSH_POLL = 1000 * 15;
// Index changes are buffered in memory and written to the BulkDatabase2 in batches
const INDEX_FLUSH_INTERVAL = 1000 * 30;
// Sources that support getChangesAfter are polled this often
const CHANGES_POLL_INTERVAL = 1000 * 60;
// Sources that don't support getChangesAfter get a full metadata rescan this often
const FULL_RESCAN_INTERVAL = 1000 * 60 * 60;
// On a request for a file the index doesn't know, changes-after sources are re-polled, at most
// this often
const MISS_CHECK_INTERVAL = 1000 * 5;
// Change polls re-request this much overlap, so clock skew between us and a source can't drop changes
const CHANGES_POLL_OVERLAP = timeInMinute;
const SCAN_RETRY_DELAY = 1000 * 30;

export type WriteConfig = {
    // Resolve once the write is in memory; flush to the sources after writeDelay, coalescing
    // writes to the same key (only the latest is written). Data is lost if the process crashes first.
    fast?: boolean;
    writeDelay?: number;
    // Stamps the write with this last-write time instead of now. Older than the current file's
    // time no-ops; more than 15 minutes in the future throws. See IArchives.set.
    lastModified?: number;
};

// What the storage server needs from a bucket's store. BlobStore implements it fully; ArchivesDisk
// also satisfies it (used directly for rawDisk buckets), minus the optional index-backed methods.
export type IBucketStore = {
    get(fileName: string, config?: { range?: { start: number; end: number } }): Promise<Buffer | undefined>;
    get2(fileName: string, config?: { range?: { start: number; end: number } }): Promise<{ data: Buffer; writeTime: number } | undefined>;
    set(fileName: string, data: Buffer, config?: WriteConfig): Promise<void>;
    del(fileName: string, config?: WriteConfig): Promise<void>;
    getInfo(fileName: string): Promise<{ writeTime: number; size: number } | undefined>;
    findInfo(prefix: string, config?: { shallow?: boolean; type?: "files" | "folders" }): Promise<ArchiveFileInfo[]>;
    getChangesAfter?(time: number): Promise<ArchiveFileInfo[]>;
    getSyncStatus?(): Promise<ArchivesSyncStatus>;
    startLargeUpload(): Promise<string>;
    appendLargeUpload(id: string, data: Buffer): Promise<void>;
    finishLargeUpload(id: string, key: string): Promise<void>;
    cancelLargeUpload(id: string): Promise<void>;
};

type OverlayEntry = {
    // undefined data means a pending delete
    data: Buffer | undefined;
    t: number;
    flushAt: number;
};

// One row of the BulkDatabase2 index (key is the file path)
type BlobIndexEntry = {
    key: string;
    writeTime: number;
    size: number;
    // Which synchronization source currently holds the data (an index into the sources array)
    source: number;
};
type IndexEntry = {
    writeTime: number;
    size: number;
    source: number;
    // When WE last changed this entry (not the file's write time) — what getChangesAfter filters
    // on, so late-arriving files with old write times are still reported as changes
    changedAt: number;
};

type SourceState = {
    supportsChangesAfter: boolean;
    initialScan: ReturnType<typeof promiseObj>;
    scanComplete: boolean;
    // Files seen in this source's scans / change polls so far
    scannedCount: number;
    // Watermark for getChangesAfter polls
    changesAfterTime: number;
    lastMissCheck: number;
};

export class BlobStore implements IBucketStore {
    constructor(
        private folder: string,
        private sources: ArchivesSource[],
        private config?: {
            // Called whenever a key's index entry changes (our own writes AND files pulled in via
            // synchronization) — how the storage server notices routing config updates.
            onIndexChanged?: (key: string) => void;
        }
    ) { }

    private stopped = { stop: false };

    // The index's BulkDatabase2 files live under <folder>/index
    private index = new BulkDatabaseBase<BlobIndexEntry>("blobIndex", noopReactiveDeps, async (p: string) => {
        let base: DirectoryWrapper = new NodeJSDirectoryHandleWrapper(path.join(this.folder, "index"));
        for (let part of p.split("/")) {
            if (part) base = await base.getDirectoryHandle(part, { create: true });
        }
        return wrapHandle(base);
    });
    // The in-memory copy of the index. All reads are served from it; changes are buffered in
    // dirty and flushed to the BulkDatabase2 in batches (undefined = delete).
    private mem = new Map<string, IndexEntry>();
    private dirty = new Map<string, IndexEntry | undefined>();
    private overlay = new Map<string, OverlayEntry>();
    private sourceStates = this.sources.map((): SourceState => ({
        supportsChangesAfter: false,
        initialScan: promiseObj(),
        scanComplete: false,
        scannedCount: 0,
        changesAfterTime: 0,
        lastMissCheck: 0,
    }));

    public init = lazy(async () => {
        await this.loadIndex();
        for (let i = 0; i < this.sources.length; i++) {
            void this.runSourceSync(i);
        }
        runInfinitePoll(FAST_FLUSH_POLL, () => this.flushOverlay(), this.stopped);
        runInfinitePoll(INDEX_FLUSH_INTERVAL, () => this.flushIndex(), this.stopped);
    });

    // Stops all synchronization scans/polls and flushes pending writes. Used when a bucket's
    // routing config changes and the store is rebuilt with new sources.
    public async dispose(): Promise<void> {
        this.stopped.stop = true;
        await this.flushOverlay(true);
        await this.flushIndex();
    }

    private async loadIndex(): Promise<void> {
        let [writeTimes, sizes, sources] = await Promise.all([
            this.index.getColumn("writeTime"),
            this.index.getColumn("size"),
            this.index.getColumn("source"),
        ]);
        let sizeMap = new Map(sizes.map(x => [x.key, x.value]));
        let sourceMap = new Map(sources.map(x => [x.key, x.value]));
        for (let entry of writeTimes) {
            let size = sizeMap.get(entry.key);
            let source = sourceMap.get(entry.key);
            // Explicit checks, as 0 is a valid size and a valid source number
            if (size === undefined || source === undefined) continue;
            this.mem.set(entry.key, { writeTime: entry.value, size, source, changedAt: entry.time });
        }
    }

    private setIndexEntry(key: string, entry: { writeTime: number; size: number; source: number }): void {
        let full: IndexEntry = { ...entry, changedAt: Date.now() };
        this.mem.set(key, full);
        this.dirty.set(key, full);
        this.config?.onIndexChanged?.(key);
    }
    private deleteIndexEntry(key: string): void {
        if (!this.mem.has(key)) return;
        this.mem.delete(key);
        this.dirty.set(key, undefined);
    }

    private async flushIndex(): Promise<void> {
        if (!this.dirty.size) return;
        let dirty = this.dirty;
        this.dirty = new Map();
        let writes: BlobIndexEntry[] = [];
        let deletes: string[] = [];
        for (let [key, entry] of dirty) {
            if (entry) {
                writes.push({ key, writeTime: entry.writeTime, size: entry.size, source: entry.source });
            } else {
                deletes.push(key);
            }
        }
        if (writes.length) await this.index.writeBatch(writes);
        if (deletes.length) await this.index.deleteBatch(deletes);
    }

    // ── synchronization ──

    private async runSourceSync(sourceIndex: number): Promise<void> {
        let { source, options } = this.sources[sourceIndex];
        let state = this.sourceStates[sourceIndex];
        while (!this.stopped.stop) {
            try {
                let config = await source.getConfig();
                state.supportsChangesAfter = !!(config.supportsChangesAfter && source.getChangesAfter);
                await this.scanSource(sourceIndex);
                break;
            } catch (e) {
                console.error(`Initial scan of sync source ${source.getDebugName()} failed, retrying:`, e);
                await delay(SCAN_RETRY_DELAY);
            }
        }
        state.scanComplete = true;
        state.initialScan.resolve(undefined);
        if (this.stopped.stop) return;
        if (options.copyFiles) {
            try {
                await this.copySourceFiles(sourceIndex);
            } catch (e) {
                console.error(`Copying files from sync source ${source.getDebugName()} failed:`, e);
            }
        }
        if (state.supportsChangesAfter) {
            runInfinitePoll(CHANGES_POLL_INTERVAL, async () => {
                await this.pollChanges(sourceIndex);
                if (options.copyFiles) await this.copySourceFiles(sourceIndex);
            }, this.stopped);
        } else {
            runInfinitePoll(FULL_RESCAN_INTERVAL, async () => {
                await this.scanSource(sourceIndex);
                if (options.copyFiles) await this.copySourceFiles(sourceIndex);
            }, this.stopped);
        }
    }

    // Full metadata scan (size, writeTime, path) of one source, applied to the index
    private async scanSource(sourceIndex: number): Promise<void> {
        let { source } = this.sources[sourceIndex];
        let state = this.sourceStates[sourceIndex];
        let scanStart = Date.now();
        let files = await source.findInfo("");
        let seen = new Set<string>();
        for (let file of files) {
            seen.add(file.path);
            this.applyScanned(sourceIndex, file);
        }
        state.scannedCount = files.length;
        // Index entries this source was the holder of, but that vanished from it (e.g. deleted
        // while we were offline), come out of the index. Entries changed after the scan started
        // are kept — the scan listing may simply predate them.
        for (let [key, entry] of this.mem) {
            if (entry.source !== sourceIndex) continue;
            if (seen.has(key)) continue;
            if (entry.changedAt >= scanStart) continue;
            this.deleteIndexEntry(key);
        }
        state.changesAfterTime = Math.max(state.changesAfterTime, scanStart - CHANGES_POLL_OVERLAP);
    }

    private applyScanned(sourceIndex: number, file: ArchiveFileInfo): void {
        let [windowStart, windowEnd] = this.sources[sourceIndex].options.validWindow;
        if (file.createTime < windowStart || file.createTime > windowEnd) return;
        let existing = this.mem.get(file.path);
        // The highest write time wins across all sources (ties keep the existing entry)
        if (existing && file.createTime <= existing.writeTime) return;
        this.setIndexEntry(file.path, { writeTime: file.createTime, size: file.size, source: sourceIndex });
    }

    private async pollChanges(sourceIndex: number): Promise<void> {
        let { source } = this.sources[sourceIndex];
        if (!source.getChangesAfter) return;
        let state = this.sourceStates[sourceIndex];
        let pollStart = Date.now();
        let changes = await source.getChangesAfter(state.changesAfterTime);
        for (let file of changes) {
            this.applyScanned(sourceIndex, file);
        }
        state.scannedCount += changes.length;
        state.changesAfterTime = pollStart - CHANGES_POLL_OVERLAP;
    }

    // Downloads the files a copyFiles source currently holds into the cacheReads sources (the
    // local cache), preserving their modified times — so a newer local write always wins
    private async copySourceFiles(sourceIndex: number): Promise<void> {
        let { source } = this.sources[sourceIndex];
        let targets: number[] = [];
        for (let i = 0; i < this.sources.length; i++) {
            if (i !== sourceIndex && this.sources[i].options.cacheReads) targets.push(i);
        }
        if (!targets.length) return;
        for (let [key, entry] of this.mem) {
            if (entry.source !== sourceIndex) continue;
            let result = await source.get2(key);
            if (!result) continue;
            for (let target of targets) {
                await this.sources[target].source.set(key, result.data, { lastModified: result.writeTime });
            }
            // Only move the entry's source if it wasn't changed while we copied
            if (this.mem.get(key) === entry) {
                this.setIndexEntry(key, { writeTime: result.writeTime, size: result.data.length, source: targets[0] });
            }
        }
    }

    // findInfo and getChangesAfter list from the index, so they must wait for the required
    // sources' initial scans (which might lag minutes) before the listing is trustworthy
    private async waitForRequiredScans(): Promise<void> {
        for (let i = 0; i < this.sources.length; i++) {
            if (!this.sources[i].options.required) continue;
            await this.sourceStates[i].initialScan.promise;
        }
    }

    // A requested file isn't in the index: required sources that haven't finished their initial
    // scan are checked directly, and changes-after sources are re-polled (at most every 5 seconds)
    private async checkMissingKey(key: string): Promise<void> {
        for (let i = 0; i < this.sources.length; i++) {
            let { source, options } = this.sources[i];
            let state = this.sourceStates[i];
            if (options.required && !state.scanComplete) {
                let info = await source.getInfo(key);
                if (info) {
                    this.applyScanned(i, { path: key, createTime: info.writeTime, size: info.size });
                }
                continue;
            }
            if (state.supportsChangesAfter && Date.now() - state.lastMissCheck > MISS_CHECK_INTERVAL) {
                state.lastMissCheck = Date.now();
                await this.pollChanges(i);
            }
        }
    }

    private async getIndexEntry(key: string): Promise<IndexEntry | undefined> {
        let entry = this.mem.get(key);
        if (entry && this.sources[entry.source]) return entry;
        if (entry) {
            // The source list changed and this entry's source no longer exists; treat as missing
            this.deleteIndexEntry(key);
        }
        await this.checkMissingKey(key);
        return this.mem.get(key);
    }

    // ── data operations ──

    public async get(key: string, config?: { range?: { start: number; end: number } }): Promise<Buffer | undefined> {
        let result = await this.get2(key, config);
        return result && result.data || undefined;
    }

    public async get2(key: string, config?: { range?: { start: number; end: number } }): Promise<{ data: Buffer; writeTime: number } | undefined> {
        await this.init();
        let range = config?.range;
        let overlayEntry = this.overlay.get(key);
        if (overlayEntry) {
            if (!overlayEntry.data) return undefined;
            let data = overlayEntry.data;
            if (range) {
                data = data.subarray(Math.min(range.start, data.length), Math.min(range.end, data.length));
            }
            return { data, writeTime: overlayEntry.t };
        }
        let entry = await this.getIndexEntry(key);
        if (!entry) return undefined;
        let { source, options } = this.sources[entry.source];
        let result = await source.get2(key, { range });
        if (!result) {
            // The source no longer has it, so our index entry was stale
            this.deleteIndexEntry(key);
            return undefined;
        }
        // Ranged reads can't populate a cache (they're partial)
        if (!options.cacheReads && !range) {
            await this.cacheRead(key, result);
        }
        return result;
    }

    // The read didn't come from a cacheReads source, so write it into all of them (using them as
    // caches), and the first one becomes the entry's new source
    private async cacheRead(key: string, result: { data: Buffer; writeTime: number }): Promise<void> {
        let first: number | undefined;
        for (let i = 0; i < this.sources.length; i++) {
            if (!this.sources[i].options.cacheReads) continue;
            await this.sources[i].source.set(key, result.data, { lastModified: result.writeTime });
            if (first === undefined) first = i;
        }
        if (first === undefined) return;
        this.setIndexEntry(key, { writeTime: result.writeTime, size: result.data.length, source: first });
    }

    public async set(key: string, data: Buffer, config?: WriteConfig): Promise<void> {
        await this.init();
        let lastModified = config?.lastModified;
        if (lastModified) {
            assertValidLastModified(lastModified);
            let overlayEntry = this.overlay.get(key);
            let entry = this.mem.get(key);
            let currentTime = overlayEntry && overlayEntry.t || entry && entry.writeTime || 0;
            // An older write never overwrites a newer one (see IArchives.set)
            if (lastModified < currentTime) return;
        }
        let writeTime = lastModified || Date.now();
        if (config?.fast) {
            let writeDelay = config.writeDelay || DEFAULT_FAST_WRITE_DELAY;
            this.overlay.set(key, { data, t: writeTime, flushAt: Date.now() + writeDelay });
            return;
        }
        this.overlay.delete(key);
        await this.writeToSources(key, data, writeTime);
    }

    private async writeToSources(key: string, data: Buffer, writeTime: number): Promise<void> {
        let first: number | undefined;
        for (let i = 0; i < this.sources.length; i++) {
            if (this.sources[i].options.noWriteBack) continue;
            await this.sources[i].source.set(key, data, { lastModified: writeTime });
            if (first === undefined) first = i;
        }
        if (first === undefined) {
            throw new Error(`Every source is noWriteBack, so writes cannot be stored (store ${this.folder})`);
        }
        this.setIndexEntry(key, { writeTime, size: data.length, source: first });
    }

    public async del(key: string, config?: WriteConfig): Promise<void> {
        await this.init();
        if (config?.fast) {
            let writeDelay = config.writeDelay || DEFAULT_FAST_WRITE_DELAY;
            this.overlay.set(key, { data: undefined, t: Date.now(), flushAt: Date.now() + writeDelay });
            return;
        }
        this.overlay.delete(key);
        await this.deleteFromSources(key);
    }

    private async deleteFromSources(key: string): Promise<void> {
        for (let i = 0; i < this.sources.length; i++) {
            if (this.sources[i].options.noWriteBack) continue;
            await this.sources[i].source.del(key);
        }
        this.deleteIndexEntry(key);
    }

    public async getInfo(key: string): Promise<{ writeTime: number; size: number } | undefined> {
        await this.init();
        let overlayEntry = this.overlay.get(key);
        if (overlayEntry) {
            if (!overlayEntry.data) return undefined;
            return { writeTime: overlayEntry.t, size: overlayEntry.data.length };
        }
        let entry = await this.getIndexEntry(key);
        if (!entry) return undefined;
        return { writeTime: entry.writeTime, size: entry.size };
    }

    public async findInfo(prefix: string, config?: { shallow?: boolean; type?: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        await this.init();
        await this.waitForRequiredScans();
        let infos = new Map<string, ArchiveFileInfo>();
        for (let [key, entry] of this.mem) {
            if (!key.startsWith(prefix)) continue;
            infos.set(key, { path: key, createTime: entry.writeTime, size: entry.size });
        }
        for (let [key, overlayEntry] of this.overlay) {
            if (!key.startsWith(prefix)) continue;
            if (!overlayEntry.data) {
                infos.delete(key);
                continue;
            }
            infos.set(key, { path: key, createTime: overlayEntry.t, size: overlayEntry.data.length });
        }
        let files = applyFindInfoShape(Array.from(infos.values()), prefix, config);
        sort(files, x => x.path);
        return files;
    }

    // All files changed after the given time — fast, straight from the in-memory index. Filters on
    // when WE learned of the change (changedAt), so files synchronized late (with old write times)
    // are still reported. Deletions are not reported.
    public async getChangesAfter(time: number): Promise<ArchiveFileInfo[]> {
        await this.init();
        await this.waitForRequiredScans();
        let files: ArchiveFileInfo[] = [];
        for (let [key, entry] of this.mem) {
            if (entry.changedAt <= time) continue;
            if (this.overlay.has(key)) continue;
            files.push({ path: key, createTime: entry.writeTime, size: entry.size });
        }
        for (let [key, overlayEntry] of this.overlay) {
            if (!overlayEntry.data) continue;
            if (overlayEntry.t <= time) continue;
            files.push({ path: key, createTime: overlayEntry.t, size: overlayEntry.data.length });
        }
        sort(files, x => x.path);
        return files;
    }

    public async getSyncStatus(): Promise<ArchivesSyncStatus> {
        await this.init();
        return {
            allScansComplete: this.sourceStates.every(x => x.scanComplete),
            indexSize: this.mem.size,
            sources: this.sources.map((x, i) => ({
                debugName: x.source.getDebugName(),
                options: x.options,
                supportsChangesAfter: this.sourceStates[i].supportsChangesAfter,
                initialScanComplete: this.sourceStates[i].scanComplete,
                scannedCount: this.sourceStates[i].scannedCount,
            })),
        };
    }

    // ── large uploads ──
    // Large uploads stream onto the local disk source directly (they may not fit in memory)

    private getDiskSource(): { disk: ArchivesDisk; sourceIndex: number } {
        for (let i = 0; i < this.sources.length; i++) {
            let source = this.sources[i].source;
            if (source instanceof ArchivesDisk) return { disk: source, sourceIndex: i };
        }
        throw new Error(`Large uploads require an ArchivesDisk source, and this store has none (store ${this.folder})`);
    }
    public async startLargeUpload(): Promise<string> {
        await this.init();
        return await this.getDiskSource().disk.startLargeUpload();
    }
    public async appendLargeUpload(id: string, data: Buffer): Promise<void> {
        await this.getDiskSource().disk.appendLargeUpload(id, data);
    }
    public async finishLargeUpload(id: string, key: string): Promise<void> {
        let { disk, sourceIndex } = this.getDiskSource();
        await disk.finishLargeUpload(id, key);
        this.overlay.delete(key);
        let info = await disk.getInfo(key);
        if (info) {
            this.setIndexEntry(key, { writeTime: info.writeTime, size: info.size, source: sourceIndex });
        }
    }
    public async cancelLargeUpload(id: string): Promise<void> {
        await this.getDiskSource().disk.cancelLargeUpload(id);
    }

    private async flushOverlay(force?: boolean): Promise<void> {
        let now = Date.now();
        for (let [key, entry] of this.overlay) {
            if (!force && entry.flushAt > now) continue;
            if (entry.data) {
                await this.writeToSources(key, entry.data, entry.t);
            } else {
                await this.deleteFromSources(key);
            }
            // Only remove if it wasn't overwritten while we were flushing
            if (this.overlay.get(key) === entry) {
                this.overlay.delete(key);
            }
        }
    }
}
