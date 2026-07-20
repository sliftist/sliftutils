import path from "path";
import { lazy } from "socket-function/src/caching";
import { runInfinitePoll, delay } from "socket-function/src/batching";
import { timeInMinute, sort, promiseObj } from "socket-function/src/misc";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import {
    IArchives, ArchiveFileInfo, ArchivesSource, ArchivesSyncStatus, assertValidLastModified,
    windowAcceptsWrites, SyncActivity,
} from "../IArchives";
import { ArchivesDisk, applyFindInfoShape } from "../ArchivesDisk";
import { ArchivesBackblaze } from "../backblaze";
import { ROUTING_FILE, getRoute, routeContains } from "./remoteConfig";
import { BulkDatabaseBase, noopReactiveDeps } from "../BulkDatabase2/BulkDatabaseBase";
import { wrapHandle, NodeJSDirectoryHandleWrapper, DirectoryWrapper } from "../FileFolderAPI";

// The storage engine of the remote storage server. Data lives in synchronization sources (at
// minimum an ArchivesDisk, the local disk); BlobStore keeps an index of every file (path, last
// modified time, size, and which source currently holds the data) in a BulkDatabase2, and
// synchronizes the index from all sources (see ArchivesSource in IArchives.ts).
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
// Deletes are tombstones (an empty file IS a missing file): the size-0 index entry is what lets a
// deletion propagate/reconcile like any other write, and it expires after this long
const TOMBSTONE_EXPIRY = 1000 * 60 * 60 * 24 * 7;
const TOMBSTONE_CLEANUP_INTERVAL = 1000 * 60 * 60;
// While a metadata scan or full sync is running, its progress is logged this often
const SYNC_PROGRESS_LOG_INTERVAL = 1000 * 60;
const DISK_LIMIT_CHECK_INTERVAL = 1000 * 60;
// Full syncs download this many files concurrently (high-latency sources like backblaze would
// otherwise crawl one round-trip at a time)
const FULL_SYNC_PARALLEL = 8;
// A full sync running longer than this is console.errored (and again every interval after), so a
// sync that will take days is loud instead of a quiet console.log every minute
const FULL_SYNC_SLOW_ERROR_INTERVAL = 1000 * 60 * 60;

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
    get2(fileName: string, config?: { range?: { start: number; end: number } }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined>;
    set(fileName: string, data: Buffer, config?: WriteConfig): Promise<string>;
    del(fileName: string, config?: WriteConfig): Promise<void>;
    getInfo(fileName: string): Promise<{ writeTime: number; size: number } | undefined>;
    findInfo(prefix: string, config?: { shallow?: boolean; type?: "files" | "folders" }): Promise<ArchiveFileInfo[]>;
    getChangesAfter?(time: number): Promise<ArchiveFileInfo[]>;
    getSyncStatus?(): Promise<ArchivesSyncStatus>;
    getSyncProgress?(): {
        index: { fileCount: number; byteCount: number };
        sources: { debugName: string; fileCount: number; byteCount: number }[];
        readerDiskLimit?: number;
        syncing: SyncActivity[];
    };
    computeIndexTotals?(): Promise<{ fileCount: number; byteCount: number; sources: { debugName: string; fileCount: number; byteCount: number }[] }>;
    startLargeUpload(): Promise<string>;
    appendLargeUpload(id: string, data: Buffer): Promise<void>;
    finishLargeUpload(id: string, key: string): Promise<void>;
    cancelLargeUpload(id: string): Promise<void>;
};

type OverlayEntry = {
    // A zero-length buffer is a pending delete (tombstone)
    data: Buffer;
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
    // In-memory only (not persisted): when the file was last served, for readerDiskLimit's LRU
    // eviction. Starts as changedAt on load.
    lastAccess: number;
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
            // LRU-bound the disk (base source) to this many bytes; see CommonConfig.readerDiskLimit
            readerDiskLimit?: number;
            // Deploy takeover: fast-write flush delays never extend past this time, and after it
            // fast writes flush immediately (nothing may sit in memory when the write window
            // transfers to the successor process)
            getFlushDeadline?: () => number | undefined;
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
    // Live totals over mem (tombstones excluded), adjusted on every mutation and recomputed on
    // load - so any drift heals on restart. computeIndexTotals gives the walk-the-index truth.
    private indexFileCount = 0;
    private indexByteCount = 0;
    // The same totals per holding source (index 0 = our disk, which readerDiskLimit bounds)
    private sourceFileCounts = this.sources.map(() => 0);
    private sourceByteCounts = this.sources.map(() => 0);
    // Background scans / full syncs currently in progress (a Set - one source can have a change
    // poll's full sync and a rescan overlapping)
    private syncActivities = new Set<SyncActivity>();
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
        runInfinitePoll(TOMBSTONE_CLEANUP_INTERVAL, () => this.cleanupTombstones(), this.stopped);
        if (this.config?.readerDiskLimit) {
            runInfinitePoll(DISK_LIMIT_CHECK_INTERVAL, () => this.enforceDiskLimit(), this.stopped);
        }
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
            let full: IndexEntry = { writeTime: entry.value, size, source, changedAt: entry.time, lastAccess: entry.time };
            this.mem.set(entry.key, full);
            this.countEntry(full, 1);
        }
    }

    private countEntry(entry: IndexEntry | undefined, direction: number): void {
        if (!entry || entry.size === 0) return;
        this.indexFileCount += direction;
        this.indexByteCount += entry.size * direction;
        // A stale entry can reference a source that no longer exists (getIndexEntry cleans those)
        if (this.sources[entry.source]) {
            this.sourceFileCounts[entry.source] += direction;
            this.sourceByteCounts[entry.source] += entry.size * direction;
        }
    }

    private setIndexEntry(key: string, entry: { writeTime: number; size: number; source: number }): void {
        let full: IndexEntry = { ...entry, changedAt: Date.now(), lastAccess: Date.now() };
        this.countEntry(this.mem.get(key), -1);
        this.countEntry(full, 1);
        this.mem.set(key, full);
        this.dirty.set(key, full);
        this.config?.onIndexChanged?.(key);
    }
    private deleteIndexEntry(key: string): void {
        let existing = this.mem.get(key);
        if (!existing) return;
        this.countEntry(existing, -1);
        this.mem.delete(key);
        this.dirty.set(key, undefined);
    }

    /** Rescans our own disk's metadata into the index - used around deploy switchovers, where the
     *  other process wrote files to the shared folder that our index hasn't seen. */
    public async rescanBase(): Promise<void> {
        await this.init();
        await this.scanSource(0);
    }

    /** The cheap always-current totals plus any in-progress background synchronization. */
    public getSyncProgress(): {
        index: { fileCount: number; byteCount: number };
        sources: { debugName: string; fileCount: number; byteCount: number }[];
        readerDiskLimit?: number;
        syncing: SyncActivity[];
    } {
        return {
            index: { fileCount: this.indexFileCount, byteCount: this.indexByteCount },
            sources: this.sources.map((x, i) => ({
                debugName: x.source.getDebugName(),
                fileCount: this.sourceFileCounts[i],
                byteCount: this.sourceByteCounts[i],
            })),
            readerDiskLimit: this.config?.readerDiskLimit,
            syncing: [...this.syncActivities],
        };
    }

    /** Walks the whole index for exact totals - more expensive than getSyncProgress, but immune to
     *  any drift in the maintained counters (and loads the index first, so it's never cold zeros). */
    public async computeIndexTotals(): Promise<{
        fileCount: number;
        byteCount: number;
        sources: { debugName: string; fileCount: number; byteCount: number }[];
    }> {
        await this.init();
        let fileCount = 0;
        let byteCount = 0;
        let sources = this.sources.map(x => ({ debugName: x.source.getDebugName(), fileCount: 0, byteCount: 0 }));
        for (let entry of this.mem.values()) {
            if (entry.size === 0) continue;
            fileCount++;
            byteCount += entry.size;
            let source = sources[entry.source];
            if (source) {
                source.fileCount++;
                source.byteCount += entry.size;
            }
        }
        return { fileCount, byteCount, sources };
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
        let { source, noFullSync } = this.sources[sourceIndex];
        let state = this.sourceStates[sourceIndex];
        let listing: Map<string, number> | undefined;
        while (!this.stopped.stop) {
            try {
                let config = await source.getConfig();
                state.supportsChangesAfter = !!(config.supportsChangesAfter && source.getChangesAfter);
                listing = await this.scanSource(sourceIndex);
                break;
            } catch (e) {
                console.error(`Initial scan of sync source ${source.getDebugName()} failed, retrying:`, e);
                await delay(SCAN_RETRY_DELAY);
            }
        }
        state.scanComplete = true;
        state.initialScan.resolve(undefined);
        if (this.stopped.stop) return;
        if (listing) {
            await this.reconcileSource(sourceIndex, listing);
        }
        if (!noFullSync) {
            try {
                await this.copySourceFiles(sourceIndex);
            } catch (e) {
                console.error(`Copying files from sync source ${source.getDebugName()} failed:`, e);
            }
        }
        if (state.supportsChangesAfter) {
            runInfinitePoll(CHANGES_POLL_INTERVAL, async () => {
                await this.pollChanges(sourceIndex);
                if (!noFullSync) await this.copySourceFiles(sourceIndex);
            }, this.stopped);
            // Change polls only show what the source HAS, never what it's missing, so pushes run on
            // the full-rescan cadence (findInfo on an index-backed source is cheap)
            runInfinitePoll(FULL_RESCAN_INTERVAL, async () => {
                let files = await source.findInfo("");
                await this.reconcileSource(sourceIndex, new Map(files.map(x => [x.path, x.createTime])));
            }, this.stopped);
        } else {
            runInfinitePoll(FULL_RESCAN_INTERVAL, async () => {
                let rescan = await this.scanSource(sourceIndex);
                await this.reconcileSource(sourceIndex, rescan);
                if (!noFullSync) await this.copySourceFiles(sourceIndex);
            }, this.stopped);
        }
    }

    // Full metadata scan (size, writeTime, path) of one source, applied to the index. Returns the
    // source's listing (path -> write time), which reconcileSource uses for the push direction.
    private async scanSource(sourceIndex: number): Promise<Map<string, number>> {
        let { source } = this.sources[sourceIndex];
        let state = this.sourceStates[sourceIndex];
        let scanStart = Date.now();
        let activity: SyncActivity = { type: "metadataScan", sourceDebugName: source.getDebugName(), startTime: scanStart };
        this.syncActivities.add(activity);
        console.log(`Metadata scan of ${source.getDebugName()} starting (store ${this.folder})`);
        let progressTimer = setInterval(() => {
            console.log(`Metadata scan of ${source.getDebugName()} still running (${Math.round((Date.now() - scanStart) / 1000)}s, store ${this.folder})`);
        }, SYNC_PROGRESS_LOG_INTERVAL);
        (progressTimer as { unref?: () => void }).unref?.();
        let files: ArchiveFileInfo[];
        try {
            files = await source.findInfo("");
        } finally {
            clearInterval(progressTimer);
            this.syncActivities.delete(activity);
        }
        console.log(`Metadata scan of ${source.getDebugName()} finished: ${files.length} files in ${Math.round((Date.now() - scanStart) / 1000)}s (store ${this.folder})`);
        let seen = new Map<string, number>();
        for (let file of files) {
            seen.set(file.path, file.createTime);
            this.applyScanned(sourceIndex, file);
        }
        state.scannedCount = files.length;
        // Index entries this source was the holder of, but that vanished from it (e.g. deleted
        // while we were offline), come out of the index. Entries changed after the scan started
        // are kept — the scan listing may simply predate them. Tombstones have no physical file
        // for a listing to vouch for, so they're exempt (cleanupTombstones expires them instead).
        for (let [key, entry] of this.mem) {
            if (entry.source !== sourceIndex) continue;
            if (entry.size === 0) continue;
            if (seen.has(key)) continue;
            if (entry.changedAt >= scanStart) continue;
            this.deleteIndexEntry(key);
        }
        state.changesAfterTime = Math.max(state.changesAfterTime, scanStart - CHANGES_POLL_OVERLAP);
        return seen;
    }

    // The push direction of synchronization: everything we know that the source is missing (or
    // holds an older copy of) is written to it — including deletions, as tombstone writes. This is
    // what heals a source whose background writes failed (e.g. it was down): the next scan sees
    // what's missing and re-sends it.
    private async reconcileSource(sourceIndex: number, listing: Map<string, number>): Promise<void> {
        let { source, validWindow, route } = this.sources[sourceIndex];
        let acceptsWrites = windowAcceptsWrites(validWindow);
        try {
            for (let [key, entry] of this.mem) {
                if (this.stopped.stop) return;
                if (entry.source === sourceIndex) continue;
                // Past-window sources only receive the routing file (see writeToSources), and
                // sharded sources only the keys routing into them
                if (key !== ROUTING_FILE) {
                    if (!acceptsWrites) continue;
                    if (!routeContains(route, getRoute(key))) continue;
                }
                let theirTime = listing.get(key);
                if (theirTime !== undefined && theirTime >= entry.writeTime) continue;
                if (entry.size === 0) {
                    // A deletion only needs pushing while the source still holds an older copy
                    if (theirTime === undefined) continue;
                    await source.set(key, Buffer.alloc(0), { lastModified: entry.writeTime });
                    continue;
                }
                let result = await this.sources[entry.source].source.get2(key);
                if (!result) continue;
                await source.set(key, result.data, { lastModified: result.writeTime });
            }
        } catch (e) {
            // Abort the pass instead of logging per file; the next scan cycle retries
            console.error(`Reconciling sync source ${source.getDebugName()} failed: ${(e as Error).stack ?? e}`);
        }
    }

    private applyScanned(sourceIndex: number, file: ArchiveFileInfo): void {
        let { validWindow, route } = this.sources[sourceIndex];
        let [windowStart, windowEnd] = validWindow;
        if (file.createTime < windowStart || file.createTime > windowEnd) return;
        // A partially-overlapping shard's listing includes keys outside our route; ignore them
        if (file.path !== ROUTING_FILE && !routeContains(route, getRoute(file.path))) return;
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

    // Downloads the files a source currently holds onto our own base source (the local disk),
    // preserving their modified times — so a newer local write always wins. Skipped for noFullSync
    // sources (fronting a large database without copying it); reads still down-cache lazily.
    private async copySourceFiles(sourceIndex: number): Promise<void> {
        if (sourceIndex === 0) return;
        let { source } = this.sources[sourceIndex];
        let pending: { key: string; entry: IndexEntry }[] = [];
        let totalBytes = 0;
        for (let [key, entry] of this.mem) {
            if (entry.source !== sourceIndex) continue;
            if (entry.size === 0) continue;
            pending.push({ key, entry });
            totalBytes += entry.size;
        }
        if (!pending.length) return;
        let activity: SyncActivity = {
            type: "fullSync",
            sourceDebugName: source.getDebugName(),
            startTime: Date.now(),
            doneFiles: 0,
            totalFiles: pending.length,
            doneBytes: 0,
            totalBytes,
        };
        this.syncActivities.add(activity);
        let progressLogged = false;
        let logProgress = () => {
            progressLogged = true;
            console.log(`Full sync from ${source.getDebugName()} (store ${this.folder}): ${activity.doneFiles}/${pending.length} files (${((activity.doneFiles || 0) / pending.length * 100).toFixed(1)}%), ${formatNumber(activity.doneBytes || 0)}B/${formatNumber(totalBytes)}B (${(totalBytes && (activity.doneBytes || 0) / totalBytes * 100 || 100).toFixed(1)}%)`);
        };
        let progressTimer = setInterval(logProgress, SYNC_PROGRESS_LOG_INTERVAL);
        (progressTimer as { unref?: () => void }).unref?.();
        let slowErrorTimer = setInterval(() => {
            let elapsed = Date.now() - activity.startTime;
            let doneFiles = activity.doneFiles || 0;
            let doneBytes = activity.doneBytes || 0;
            let bytesPerSecond = doneBytes / (elapsed / 1000);
            let remainingBytes = totalBytes - doneBytes;
            let etaText = "unknown (no bytes transferred yet)";
            if (bytesPerSecond > 0) {
                let remainingMs = remainingBytes / bytesPerSecond * 1000;
                etaText = `${formatTime(remainingMs)} remaining, completing around ${new Date(Date.now() + remainingMs).toISOString()}`;
            }
            console.error(`Full sync from ${source.getDebugName()} (store ${this.folder}) has been running for ${formatTime(elapsed)}: ${doneFiles}/${pending.length} files (${(doneFiles / pending.length * 100).toFixed(1)}%), ${formatNumber(doneBytes)}B/${formatNumber(totalBytes)}B (${(totalBytes && doneBytes / totalBytes * 100 || 100).toFixed(1)}%), ${formatNumber(bytesPerSecond)}B/s. Estimated ${etaText}.`);
        }, FULL_SYNC_SLOW_ERROR_INTERVAL);
        (slowErrorTimer as { unref?: () => void }).unref?.();
        try {
            let nextIndex = 0;
            let failed = false;
            let copyWorker = async () => {
                while (!failed && !this.stopped.stop) {
                    let index = nextIndex++;
                    if (index >= pending.length) return;
                    let { key, entry } = pending[index];
                    let result = await source.get2(key);
                    if (result) {
                        await this.sources[0].source.set(key, result.data, { lastModified: result.writeTime });
                        // Only move the entry's source if it wasn't changed while we copied
                        if (this.mem.get(key) === entry) {
                            this.setIndexEntry(key, { writeTime: result.writeTime, size: result.data.length, source: 0 });
                        }
                    }
                    activity.doneFiles = (activity.doneFiles || 0) + 1;
                    activity.doneBytes = (activity.doneBytes || 0) + entry.size;
                }
            };
            let workers: Promise<void>[] = [];
            for (let i = 0; i < Math.min(FULL_SYNC_PARALLEL, pending.length); i++) {
                workers.push(copyWorker().catch((e: Error) => {
                    // Stop the other workers pulling new files, then surface the error
                    failed = true;
                    throw e;
                }));
            }
            await Promise.all(workers);
        } finally {
            clearInterval(progressTimer);
            clearInterval(slowErrorTimer);
            this.syncActivities.delete(activity);
            // A sync slow enough to have logged progress also logs its completion
            if (progressLogged) {
                logProgress();
            }
        }
    }

    // findInfo and getChangesAfter list from the index, so they must wait for our own base
    // source's initial scan (which might lag minutes) before the listing is trustworthy. The base
    // (local disk) is implicitly required - remote sources are not, they come and go.
    private async waitForRequiredScans(): Promise<void> {
        await this.sourceStates[0].initialScan.promise;
    }

    // A requested file isn't in the index: our own base source (implicitly required) is checked
    // directly if its initial scan hasn't finished, and changes-after sources are re-polled (at
    // most every 5 seconds)
    private async checkMissingKey(key: string): Promise<void> {
        for (let i = 0; i < this.sources.length; i++) {
            let { source } = this.sources[i];
            let state = this.sourceStates[i];
            if (i === 0 && !state.scanComplete) {
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

    public async get2(key: string, config?: { range?: { start: number; end: number } }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        await this.init();
        let range = config?.range;
        let overlayEntry = this.overlay.get(key);
        if (overlayEntry) {
            // An empty file IS a missing file (tombstone)
            if (overlayEntry.data.length === 0) return undefined;
            let data = overlayEntry.data;
            let size = data.length;
            if (range) {
                data = data.subarray(Math.min(range.start, data.length), Math.min(range.end, data.length));
            }
            return { data, writeTime: overlayEntry.t, size };
        }
        let entry = await this.getIndexEntry(key);
        if (!entry) return undefined;
        if (entry.size === 0) return undefined;
        entry.lastAccess = Date.now();
        let holder = entry.source;
        let result: { data: Buffer; writeTime: number; size: number } | undefined;
        let holderError: Error | undefined;
        try {
            result = await this.sources[holder].source.get2(key, { range });
        } catch (e) {
            holderError = e as Error;
        }
        if (result) {
            // Ranged reads can't populate a cache (they're partial)
            if (holder !== 0 && !range) {
                await this.cacheRead(key, result);
            }
            return result;
        }
        // The holder is down or lost the file. ANY other source's copy beats no value - even an
        // OLDER one - and it's copied onto our disk so the next read doesn't depend on luck.
        for (let i = 0; i < this.sources.length; i++) {
            if (i === holder) continue;
            let fallback: { data: Buffer; writeTime: number; size: number } | undefined;
            try {
                fallback = await this.sources[i].source.get2(key);
            } catch {
                continue;
            }
            if (!fallback) continue;
            await this.cacheRead(key, fallback);
            let data = fallback.data;
            if (range) {
                data = data.subarray(Math.min(range.start, data.length), Math.min(range.end, data.length));
            }
            return { data, writeTime: fallback.writeTime, size: fallback.size };
        }
        if (holderError) throw holderError;
        // The holder answered "not there" and no other source has it either: the entry was stale
        this.deleteIndexEntry(key);
        return undefined;
    }

    // The read's bytes came from a remote source, so write them onto our own base source (the
    // local disk), which becomes the entry's new holder - reads only pay the remote fetch once
    private async cacheRead(key: string, result: { data: Buffer; writeTime: number }): Promise<void> {
        await this.sources[0].source.set(key, result.data, { lastModified: result.writeTime });
        this.setIndexEntry(key, { writeTime: result.writeTime, size: result.data.length, source: 0 });
    }

    public async set(key: string, data: Buffer, config?: WriteConfig): Promise<string> {
        await this.init();
        let lastModified = config?.lastModified;
        if (lastModified) {
            assertValidLastModified(lastModified);
            let overlayEntry = this.overlay.get(key);
            let entry = this.mem.get(key);
            let currentTime = overlayEntry && overlayEntry.t || entry && entry.writeTime || 0;
            // An older write never overwrites a newer one (see IArchives.set)
            if (lastModified < currentTime) return key;
        }
        let writeTime = lastModified || Date.now();
        if (config?.fast) {
            let writeDelay = config.writeDelay || DEFAULT_FAST_WRITE_DELAY;
            let flushAt = Date.now() + writeDelay;
            let deadline = this.config?.getFlushDeadline?.();
            if (deadline !== undefined) {
                // Past the deadline fast writes write through (deployTakeover logs the transition
                // once, with the times - a per-store log here would repeat on every store rebuild)
                if (Date.now() >= deadline) {
                    this.overlay.delete(key);
                    await this.writeToSources(key, data, writeTime);
                    return key;
                }
                flushAt = Math.min(flushAt, deadline);
            }
            this.overlay.set(key, { data, t: writeTime, flushAt });
            return key;
        }
        this.overlay.delete(key);
        await this.writeToSources(key, data, writeTime);
        return key;
    }

    public async del(key: string, config?: WriteConfig): Promise<void> {
        // Deletes are tombstone writes (an empty file IS a missing file): the size-0 index entry is
        // ordered by write time like any other write, propagates through synchronization, and
        // expires after TOMBSTONE_EXPIRY
        await this.set(key, Buffer.alloc(0), config);
    }

    private getWritableSources(config?: { ignoreWindow?: boolean }): number[] {
        let writable: number[] = [];
        for (let i = 0; i < this.sources.length; i++) {
            if (!config?.ignoreWindow && !windowAcceptsWrites(this.sources[i].validWindow)) continue;
            writable.push(i);
        }
        return writable;
    }

    private async writeToSources(key: string, data: Buffer, writeTime: number): Promise<void> {
        // The routing file is exempt from the valid-window and route write filters: the CONFIG
        // must keep flowing to every source, or a client probing one of them first would adopt a
        // stale config. Only data writes stop.
        let isRouting = key === ROUTING_FILE;
        let writable = this.getWritableSources({ ignoreWindow: isRouting });
        let first = writable.shift();
        if (first === undefined) {
            throw new Error(`No source accepts writes (every source's valid window is in the past), so writes cannot be stored (store ${this.folder})`);
        }
        // Only our own (first) source blocks the write. Downstream sources are written in the
        // background: a down downstream source must not fail or stall writes, and reconcileSource
        // re-sends anything they missed once they come back.
        if (data.length === 0) {
            // A tombstone stores nothing on our own source - the index entry alone records it
            await this.sources[first].source.del(key);
        } else {
            await this.sources[first].source.set(key, data, { lastModified: writeTime });
        }
        this.setIndexEntry(key, { writeTime, size: data.length, source: first });
        let route = !isRouting && getRoute(key) || 0;
        for (let i of writable) {
            if (!isRouting && !routeContains(this.sources[i].route, route)) continue;
            // Downstream sources receive tombstones as actual empty writes, so their listings show
            // the deletion (size 0) and other stores scan it in as a tombstone
            void this.sources[i].source.set(key, data, { lastModified: writeTime }).catch((e: Error) => {
                console.error(`Background write of ${key} to sync source ${this.sources[i].source.getDebugName()} failed: ${e.stack ?? e}`);
            });
        }
    }

    public async getInfo(key: string): Promise<{ writeTime: number; size: number } | undefined> {
        await this.init();
        let overlayEntry = this.overlay.get(key);
        if (overlayEntry) {
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
            // Tombstones are missing files, so listings hide them
            if (entry.size === 0) continue;
            infos.set(key, { path: key, createTime: entry.writeTime, size: entry.size });
        }
        for (let [key, overlayEntry] of this.overlay) {
            if (!key.startsWith(prefix)) continue;
            if (overlayEntry.data.length === 0) {
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
    // are still reported. Deletions ARE reported, as size-0 tombstone entries — that's how they
    // propagate to stores syncing from us.
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
                validWindow: x.validWindow,
                route: x.route,
                noFullSync: x.noFullSync,
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
            await this.writeToSources(key, entry.data, entry.t);
            // Only remove if it wasn't overwritten while we were flushing
            if (this.overlay.get(key) === entry) {
                this.overlay.delete(key);
            }
        }
    }

    // readerDiskLimit: the disk is only a bounded read cache, so once it exceeds the limit, the
    // least recently used files are deleted from it - but ONLY when another source verifiably
    // holds a same-or-newer copy (the only copy of a file is never deleted), and the index entry
    // repoints to that source so reads keep working (re-caching on the next read).
    private evicting = false;
    private async enforceDiskLimit(): Promise<void> {
        let limit = this.config?.readerDiskLimit;
        if (!limit || this.evicting) return;
        if (this.sourceByteCounts[0] <= limit) return;
        this.evicting = true;
        let evictedFiles = 0;
        let evictedBytes = 0;
        try {
            let candidates: { key: string; entry: IndexEntry }[] = [];
            for (let [key, entry] of this.mem) {
                if (entry.source !== 0 || entry.size === 0 || key === ROUTING_FILE) continue;
                candidates.push({ key, entry });
            }
            sort(candidates, x => x.entry.lastAccess);
            for (let { key, entry } of candidates) {
                if (this.stopped.stop) return;
                if (this.sourceByteCounts[0] <= limit) break;
                if (this.mem.get(key) !== entry) continue;
                let holder: number | undefined;
                for (let i = 1; i < this.sources.length; i++) {
                    try {
                        let info = await this.sources[i].source.getInfo(key);
                        if (info && info.writeTime >= entry.writeTime) {
                            holder = i;
                            break;
                        }
                    } catch {
                        // A down source just can't vouch for this file right now
                    }
                }
                if (holder === undefined) continue;
                await this.sources[0].source.del(key);
                this.setIndexEntry(key, { writeTime: entry.writeTime, size: entry.size, source: holder });
                evictedFiles++;
                evictedBytes += entry.size;
            }
        } finally {
            this.evicting = false;
            if (evictedFiles) {
                console.log(`Disk cache over readerDiskLimit (store ${this.folder}): evicted ${evictedFiles} least-recently-used files (${formatNumber(evictedBytes)}B), now at ${formatNumber(this.sourceByteCounts[0])}B/${formatNumber(this.config?.readerDiskLimit || 0)}B`);
            }
        }
    }

    // Tombstones only need to exist long enough for every store to learn of the deletion; expired
    // ones come out of the index. The physical empty file is removed only on backblaze sources:
    // remote stores expire their own tombstones (a del there would just mint a fresh one), and our
    // own disk never stored anything for it.
    private async cleanupTombstones(): Promise<void> {
        let cutoff = Date.now() - TOMBSTONE_EXPIRY;
        for (let [key, entry] of this.mem) {
            if (this.stopped.stop) return;
            if (entry.size !== 0) continue;
            if (entry.writeTime > cutoff) continue;
            this.deleteIndexEntry(key);
            for (let sourceEntry of this.sources) {
                if (!windowAcceptsWrites(sourceEntry.validWindow)) continue;
                let source = sourceEntry.source;
                if (!(source instanceof ArchivesBackblaze)) continue;
                void source.del(key).catch((e: Error) => {
                    console.error(`Removing expired tombstone ${key} from ${source.getDebugName()} failed: ${e.stack ?? e}`);
                });
            }
        }
    }
}
