import path from "path";
import { lazy } from "socket-function/src/caching";
import { runInfinitePoll, delay } from "socket-function/src/batching";
import { timeInMinute, sort, promiseObj } from "socket-function/src/misc";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import {
    IArchives, ArchiveFileInfo, ArchivesSource, ArchivesSyncStatus, ChangesAfterConfig, FindConfig, HostedConfig, assertValidLastModified,
    windowAcceptsWrites, SyncActivity, FULL_ROUTE, STORAGE_WRONG_VALID_WINDOW, STORAGE_WRONG_ROUTE, copyArchiveFile,
} from "../IArchives";
import { ArchivesDisk, applyFindInfoShape } from "../ArchivesDisk";
import { ArchivesBackblaze } from "../backblaze";
import { ROUTING_FILE, getRoute, routeContains } from "./remoteConfig";
import { selectEntryAt } from "./storePlan";
import { BulkDatabaseBase, noopReactiveDeps } from "../BulkDatabase2/BulkDatabaseBase";
import { wrapHandle, NodeJSDirectoryHandleWrapper, DirectoryWrapper } from "../FileFolderAPI";
import { SourcesList } from "./sourcesList";

// The storage engine of the remote storage server. Data lives in synchronization sources (at minimum an ArchivesDisk, the local disk); BlobStore keeps an index of every file (path, last modified time, size, and which source currently holds the data) in a BulkDatabase2, and synchronizes the index from all sources (see ArchivesSource in IArchives.ts). Every startup fully rescans each source's metadata, so the index self-heals; the file with the highest write time wins across all sources, so multiple sources need no stacking order. The store also holds its own routing entries (the self entries of the ONE route it serves), so it validates writes itself: valid windows, routes, immutability, and internal-push acceptance.

export const DEFAULT_FAST_WRITE_DELAY = timeInMinute * 5;
const FAST_FLUSH_POLL = 1000 * 15;
// Fast writes are never delayed past our own valid window, and within this margin of the window's end they write through immediately - so when the next window's source takes over, the writes are already on disk
export const WINDOW_END_FLUSH_MARGIN = timeInMinute * 5;
// Index changes are buffered in memory and written to the BulkDatabase2 in batches
const INDEX_FLUSH_INTERVAL = 1000 * 30;
// Sources with a native (index-backed) change feed are polled this often
const CHANGES_POLL_INTERVAL = 1000 * 60;
// Full metadata rescans. supportsChangesAfter is the heuristic for "one of our own storage servers": their index-backed listings are cheap, so hourly is fine. Everything else (backblaze, plain disk) pays the full listing cost, so it rescans much less often.
const FULL_RESCAN_INTERVAL = 1000 * 60 * 60;
const FULL_RESCAN_UNINDEXED_INTERVAL = 1000 * 60 * 60 * 6;
// On a request for a file the index doesn't know, changes-after sources are re-polled, at most this often
const MISS_CHECK_INTERVAL = 1000 * 5;
// Change polls re-request this much overlap, so clock skew between us and a source can't drop changes
const CHANGES_POLL_OVERLAP = timeInMinute;
const SCAN_RETRY_DELAY = 1000 * 30;
// Deletes are tombstones (an empty file IS a missing file): the size-0 index entry is what lets a deletion propagate/reconcile like any other write, and it expires after this long
const TOMBSTONE_EXPIRY = 1000 * 60 * 60 * 24 * 7;
const TOMBSTONE_CLEANUP_INTERVAL = 1000 * 60 * 60;
// While a metadata scan or full sync is running, its progress is logged this often
const SYNC_PROGRESS_LOG_INTERVAL = 1000 * 60;
const DISK_LIMIT_CHECK_INTERVAL = 1000 * 60;
// Full syncs download this many files concurrently (high-latency sources like backblaze would otherwise crawl one round-trip at a time)
const FULL_SYNC_PARALLEL = 8;
// A full sync running longer than this is console.errored (and again every interval after), so a sync that will take days is loud instead of a quiet console.log every minute
const FULL_SYNC_SLOW_ERROR_INTERVAL = 1000 * 60 * 60;
// A reconcile pass skips failing files (one bad value must not stop the rest), but this many failures in a row means the target itself is down, so the pass aborts until the next scan cycle
const RECONCILE_MAX_CONSECUTIVE_FAILURES = 5;
const RECONCILE_ERROR_LOG_LIMIT = 3;
const WRONG_TARGET_LOG_THROTTLE = 60 * 1000;

// What the storage server needs from a bucket's store. BlobStore implements it fully (with validation from its routing entries); RawDiskStore adapts an ArchivesDisk for rawDisk buckets (no index, no sync, no validation - raw means raw).
export type IBucketStore = {
    /** internal (store-to-store) reads answer purely from the local disk; see GetConfig.internal */
    get2(config: { path: string; range?: { start: number; end: number }; internal?: boolean; includeTombstones?: boolean }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined>;
    /** internal (store-to-store) writes go to the local disk + index with no fan-out; see SetConfig.internal */
    set(config: { path: string; data: Buffer; lastModified?: number; forceSetImmutable?: boolean; internal?: boolean }): Promise<void>;
    del(config: { path: string; lastModified?: number; internal?: boolean }): Promise<void>;
    getInfo(config: { path: string; includeTombstones?: boolean }): Promise<{ writeTime: number; size: number } | undefined>;
    findInfo(config: FindConfig & { prefix: string }): Promise<ArchiveFileInfo[]>;
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    getSyncStatus?(): Promise<ArchivesSyncStatus>;
    getSyncProgress?(): {
        index: { fileCount: number; byteCount: number };
        sources: { debugName: string; fileCount: number; byteCount: number }[];
        readerDiskLimit?: number;
        syncing: SyncActivity[];
    };
    computeIndexTotals?(): Promise<{ fileCount: number; byteCount: number; sources: { debugName: string; fileCount: number; byteCount: number }[] }>;
    /** path/lastModified let the store reject an upload into an immutable bucket before any bytes move */
    startLargeUpload(config?: { path?: string; lastModified?: number }): Promise<string>;
    appendLargeUpload(config: { id: string; data: Buffer }): Promise<void>;
    finishLargeUpload(config: { id: string; path: string; lastModified?: number }): Promise<void>;
    cancelLargeUpload(config: { id: string }): Promise<void>;
};

/** rawDisk buckets: the disk IS the store. No index, no synchronization, no window/route/immutability validation. */
export class RawDiskStore implements IBucketStore {
    constructor(private disk: ArchivesDisk) { }

    public async get2(config: { path: string; range?: { start: number; end: number }; internal?: boolean; includeTombstones?: boolean }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        return await this.disk.get2(config.path, { range: config.range, includeTombstones: config.includeTombstones });
    }
    public async set(config: { path: string; data: Buffer; lastModified?: number; forceSetImmutable?: boolean; internal?: boolean }): Promise<void> {
        await this.disk.set(config.path, config.data, { lastModified: config.lastModified });
    }
    public async del(config: { path: string; lastModified?: number; internal?: boolean }): Promise<void> {
        if (config.path === ROUTING_FILE) {
            throw new Error(`The routing config ${JSON.stringify(ROUTING_FILE)} cannot be deleted (overwrite it to change the bucket's configuration)`);
        }
        await this.disk.del(config.path, { lastModified: config.lastModified });
    }
    public async getInfo(config: { path: string; includeTombstones?: boolean }): Promise<{ writeTime: number; size: number } | undefined> {
        return await this.disk.getInfo(config.path, { includeTombstones: config.includeTombstones });
    }
    public async findInfo(config: FindConfig & { prefix: string }): Promise<ArchiveFileInfo[]> {
        return await this.disk.findInfo(config.prefix, { shallow: config.shallow, type: config.type });
    }
    public async getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]> {
        return await this.disk.getChangesAfter2(config);
    }
    public async startLargeUpload(): Promise<string> {
        return await this.disk.startLargeUpload();
    }
    public async appendLargeUpload(config: { id: string; data: Buffer }): Promise<void> {
        await this.disk.appendLargeUpload(config.id, config.data);
    }
    public async finishLargeUpload(config: { id: string; path: string; lastModified?: number }): Promise<void> {
        await this.disk.finishLargeUpload(config.id, config.path, config.lastModified);
    }
    public async cancelLargeUpload(config: { id: string }): Promise<void> {
        await this.disk.cancelLargeUpload(config.id);
    }
}

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
    // Which synchronization source currently holds the data: the line number of the source's URL in the store's append-only sources list (see SourcesList) - NOT a position in the in-memory sources array, which changes between runs
    sourcesListIndex: number;
};
type IndexEntry = {
    writeTime: number;
    size: number;
    sourcesListIndex: number;
    // When WE last changed this entry (not the file's write time) — what getChangesAfter2 filters on, so late-arriving files with old write times are still reported
    changedAt: number;
    // In-memory only (not persisted): when the file was last served, for readerDiskLimit's LRU eviction. Starts as changedAt on load.
    lastAccess: number;
};

type SourceState = {
    supportsChangesAfter: boolean;
    initialScan: ReturnType<typeof promiseObj>;
    scanComplete: boolean;
    // Files seen in this source's scans / change polls so far
    scannedCount: number;
    // Watermark for getChangesAfter2 polls
    changesAfterTime: number;
    lastMissCheck: number;
    // Per-slot stop token: a removed source's loops stop without touching the rest of the store
    stopped: { stop: boolean };
    // A removed source's slot stays in the arrays (they are never spliced, so slot numbers held by running loops stay meaningful), marked dead - never scanned, written, or read. Index entries don't reference slots at all; they persist the sources list's sourcesListIndex.
    dead?: boolean;
};

// One source of a live source-list update; see BlobStore.updateSources
export type BlobSourceSpec = {
    // Matched against ArchivesSource.identity ("disk" for the base slot); equal identities pair off in order
    identity: string;
    // See ArchivesSource.url
    url: string;
    validWindow: [number, number];
    route?: [number, number];
    noFullSync?: boolean;
    // See ArchivesSource.intermediate
    intermediate?: boolean;
    // Only called for sources that don't match an existing live slot
    create: () => IArchives;
};

// What a scanned listing entry meant when compared against our index
type ScanOutcome = "filtered" | "new" | "updated" | "tombstone" | "unchanged";
type ScanTally = Record<ScanOutcome, number>;
function newScanTally(): ScanTally {
    return { filtered: 0, new: 0, updated: 0, tombstone: 0, unchanged: 0 };
}
function formatScanTally(tally: ScanTally, total: number): string {
    let pct = (n: number) => `${Math.round(n / Math.max(total, 1) * 1000) / 10}%`;
    return `${tally.new} new paths (${pct(tally.new)}), ${tally.updated} newer writes (${pct(tally.updated)}), ${tally.tombstone} deletions (${pct(tally.tombstone)}), ${tally.unchanged} unchanged (${pct(tally.unchanged)}), ${tally.filtered} outside route (${pct(tally.filtered)})`;
}

function newSourceState(): SourceState {
    return {
        supportsChangesAfter: false,
        initialScan: promiseObj(),
        scanComplete: false,
        scannedCount: 0,
        changesAfterTime: 0,
        lastMissCheck: 0,
        stopped: { stop: false },
    };
}

let lastWrongTargetLog = 0;
function logWrongTargetRejection(message: string): void {
    if (Date.now() - lastWrongTargetLog < WRONG_TARGET_LOG_THROTTLE) return;
    lastWrongTargetLog = Date.now();
    console.log(message);
}

export class BlobStore implements IBucketStore {
    constructor(
        private folder: string,
        private sources: ArchivesSource[],
        private config?: {
            // Called whenever a key's index entry changes (our own writes AND files pulled in via synchronization) — how the storage server notices routing config updates.
            onIndexChanged?: (key: string) => void;
            // LRU-bound the disk (base source) to this many bytes; see CommonConfig.readerDiskLimit
            readerDiskLimit?: number;
            // Every accepted write ("original") and every write that actually reached the sources ("flushed"). Fast writes coalesce, so the two counts differ.
            onWriteCounted?: (kind: "original" | "flushed", bytes: number) => void;
            // Resolves a persisted source URL (see ArchivesSource.url) to a cached IArchives, so entries whose holder is no longer configured can still be read
            resolveSourceUrl?: (url: string) => IArchives;
            // This store's own entries in the routing config (all the same route, different valid windows). What set/del validate against: valid windows and routes for fresh writes, immutability, internal-push acceptance, and the fast/writeDelay flags. Empty = no validation (a store serving leftover disk data with no config).
            entries?: HostedConfig[];
        }
    ) { }

    // #region Main interface

    public init = lazy(async () => {
        for (let i = 0; i < this.sources.length; i++) {
            await this.registerSlot(i);
        }
        await this.loadIndex();
        this.syncStarted = true;
        for (let i = 0; i < this.sources.length; i++) {
            if (!this.isLive(i)) continue;
            void this.runSourceSync(i);
        }
        runInfinitePoll(FAST_FLUSH_POLL, () => this.flushOverlay(), this.stopped);
        runInfinitePoll(INDEX_FLUSH_INTERVAL, () => this.flushIndex(), this.stopped);
        runInfinitePoll(TOMBSTONE_CLEANUP_INTERVAL, () => this.cleanupTombstones(), this.stopped);
        if (this.config?.readerDiskLimit) {
            runInfinitePoll(DISK_LIMIT_CHECK_INTERVAL, () => this.enforceDiskLimit(), this.stopped);
        }
    });

    // Stops all synchronization scans/polls and flushes pending writes. Only used when the store genuinely cannot continue (rawDisk flip, process shutdown) - routine config changes go through updateSources instead, which the store survives.
    public async dispose(): Promise<void> {
        this.stopped.stop = true;
        for (let state of this.sourceStates) {
            state.stopped.stop = true;
        }
        await this.flushOverlay(true);
        await this.flushIndex();
    }

    public async get2(config: { path: string; range?: { start: number; end: number }; internal?: boolean; includeTombstones?: boolean }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        if (config.internal) {
            return await this.getInternal2(config);
        }
        await this.init();
        let key = config.path;
        let range = config.range;
        let overlayEntry = this.overlay.get(key);
        if (overlayEntry) {
            // An empty file IS a missing file (tombstone)
            if (overlayEntry.data.length === 0 && !config.includeTombstones) return undefined;
            let data = overlayEntry.data;
            let size = data.length;
            if (range) {
                data = data.subarray(Math.min(range.start, data.length), Math.min(range.end, data.length));
            }
            return { data, writeTime: overlayEntry.t, size };
        }
        let entry = await this.getIndexEntry(key);
        if (!entry) return undefined;
        if (entry.size === 0) {
            if (!config.includeTombstones) return undefined;
            // A tombstone has no stored bytes - the index entry alone is the deletion, so the flag-caller gets its write time with empty data
            return { data: Buffer.alloc(0), writeTime: entry.writeTime, size: 0 };
        }
        entry.lastAccess = Date.now();
        let holderArchives = await this.getEntryHolder(entry);
        let result: { data: Buffer; writeTime: number; size: number } | undefined;
        let holderError: Error | undefined;
        if (holderArchives) {
            try {
                // includeTombstones: the holder answering "deleted" (a tombstone, with its write time) must be distinguishable from "I lost the file" - the former is authoritative and must NOT fall back to older copies, which would resurrect the deletion for this read
                let answer = await holderArchives.get2(key, { range, internal: true, includeTombstones: true });
                if (answer && answer.data && !answer.data.length && !(range && answer.size) && answer.writeTime >= entry.writeTime) {
                    return undefined;
                }
                // NOTE: a ranged read of a real file can legitimately be empty (range past EOF), so only unranged emptiness means tombstone/absent
                if (answer && answer.data && (answer.data.length || range && answer.size)) {
                    result = { data: answer.data, writeTime: answer.writeTime, size: answer.size };
                }
            } catch (e) {
                holderError = e as Error;
            }
        }
        if (result) {
            // Ranged reads can't populate a cache (they're partial)
            if (this.slotForSourcesListIndex(entry.sourcesListIndex) !== 0 && !range) {
                await this.cacheRead(key, result);
            }
            return result;
        }
        // The routing file is only ever read off our own disk - falling back to another source's copy would synchronize it between nodes through the read path, which it never is
        if (key === ROUTING_FILE) {
            if (holderError) throw holderError;
            return undefined;
        }
        // The holder is down or lost the file. ANY other source's copy beats no value - even an OLDER one - and it's copied onto our disk so the next read doesn't depend on luck.
        let holderSlot = this.slotForSourcesListIndex(entry.sourcesListIndex);
        for (let i = 0; i < this.sources.length; i++) {
            if (i === holderSlot || !this.isLive(i)) continue;
            let fallback: { data: Buffer; writeTime: number; size: number } | undefined;
            try {
                let answer = await this.sources[i].source.get2(key, { internal: true });
                // Empty data counts as absent - a tombstone, not content (this read is unranged, so emptiness is unambiguous)
                if (answer && answer.data && answer.data.length) {
                    fallback = { data: answer.data, writeTime: answer.writeTime, size: answer.size };
                }
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

    public async set(config: { path: string; data: Buffer; lastModified?: number; forceSetImmutable?: boolean; internal?: boolean }): Promise<void> {
        let { path: key, data } = config;
        if (!data.length) {
            throw new Error(`set was called with an empty buffer for ${JSON.stringify(key)} (store ${this.folder}): an empty file IS a deletion in this system and would read back as missing - call del instead`);
        }
        await this.init();
        let writeTime = config.lastModified || Date.now();
        let route = getRoute(key);
        // The routing file defines the windows/routes, so they can't possibly apply to it (and it never flows through validation)
        if (key !== ROUTING_FILE && this.entries.length) {
            if (!config.lastModified) {
                let timeValid = this.entries.filter(x => writeTime >= x.validWindow[0] && writeTime < x.validWindow[1]);
                if (!timeValid.length) {
                    logWrongTargetRejection(`Rejecting fresh write of ${JSON.stringify(key)} (store ${this.folder}): writeTime ${writeTime} (${new Date(writeTime).toISOString()}) is outside all our valid windows ${JSON.stringify(this.entries.map(x => x.validWindow))} (a switchover moved the write target)`);
                    throw new Error(`${STORAGE_WRONG_VALID_WINDOW} This store is not a valid write target at ${writeTime} (our valid windows: ${JSON.stringify(this.entries.map(x => x.validWindow))}, store ${this.folder}). Re-resolve the currently valid source and retry.`);
                }
                if (!timeValid.some(x => routeContains(x.route, route))) {
                    logWrongTargetRejection(`Rejecting fresh write of ${JSON.stringify(key)} (store ${this.folder}): route ${route} is outside our routes ${JSON.stringify(timeValid.map(x => x.route || FULL_ROUTE))} at writeTime ${writeTime} (the client's shard config is stale)`);
                    throw new Error(`${STORAGE_WRONG_ROUTE} This store does not handle route ${route} (key ${JSON.stringify(key)}, our routes at this time: ${JSON.stringify(timeValid.map(x => x.route || FULL_ROUTE))}, store ${this.folder}). Re-resolve the source for this key and retry.`);
                }
            }
            if (config.forceSetImmutable) {
                if (!config.lastModified) {
                    throw new Error(`forceSetImmutable requires lastModified (synchronization writes are ordered by their write time), writing ${JSON.stringify(key)} (store ${this.folder})`);
                }
                // Immutability wins: an existing path is kept instead of the push throwing (see SetConfig.forceSetImmutable)
                let self = selectEntryAt(this.entries, writeTime, route);
                if (self?.immutable && await this.getInfo({ path: key })) return;
            } else {
                await this.assertMutable(key, writeTime);
            }
        }
        if (config.internal) {
            if (!config.lastModified) {
                throw new Error(`Internal writes must carry lastModified (they are synchronization pushes, ordered by their write time), writing ${JSON.stringify(key)} (store ${this.folder})`);
            }
            this.assertInternalWriteAccepted(key, config.lastModified, route);
            await this.setInternal(key, data, { lastModified: config.lastModified });
            return;
        }
        let self = this.entries.length && selectEntryAt(this.entries, writeTime, route) || undefined;
        await this.setOrDelete(key, data, { fast: self?.fast, writeDelay: self?.writeDelay, lastModified: config.lastModified });
    }

    public async del(config: { path: string; lastModified?: number; internal?: boolean }): Promise<void> {
        let key = config.path;
        if (key === ROUTING_FILE) {
            throw new Error(`The routing config ${JSON.stringify(ROUTING_FILE)} cannot be deleted (overwrite it to change the bucket's configuration)`);
        }
        await this.init();
        if (config.internal) {
            if (!config.lastModified) {
                throw new Error(`Internal deletions must carry lastModified (they are synchronization pushes, ordered by their write time), deleting ${JSON.stringify(key)} (store ${this.folder})`);
            }
            this.assertInternalWriteAccepted(key, config.lastModified, getRoute(key));
            // setInternal treats an empty buffer as exactly a deletion: disk removal plus a tombstone index entry, no fan-out
            await this.setInternal(key, Buffer.alloc(0), { lastModified: config.lastModified });
            return;
        }
        // Deletes are tombstone writes (an empty file IS a missing file): the size-0 index entry is ordered by write time like any other write, propagates through synchronization, and expires after TOMBSTONE_EXPIRY
        let writeTime = config.lastModified || Date.now();
        let self = this.entries.length && selectEntryAt(this.entries, writeTime, getRoute(key)) || undefined;
        await this.setOrDelete(key, Buffer.alloc(0), { fast: self?.fast, writeDelay: self?.writeDelay, lastModified: config.lastModified });
    }

    public async getInfo(config: { path: string; includeTombstones?: boolean }): Promise<{ writeTime: number; size: number } | undefined> {
        await this.init();
        let key = config.path;
        let overlayEntry = this.overlay.get(key);
        if (overlayEntry) {
            if (!overlayEntry.data.length && !config.includeTombstones) return undefined;
            return { writeTime: overlayEntry.t, size: overlayEntry.data.length };
        }
        let entry = await this.getIndexEntry(key);
        if (!entry) return undefined;
        if (!entry.size && !config.includeTombstones) return undefined;
        return { writeTime: entry.writeTime, size: entry.size };
    }

    public async findInfo(config: FindConfig & { prefix: string }): Promise<ArchiveFileInfo[]> {
        await this.init();
        await this.waitForRequiredScans();
        let prefix = config.prefix;
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
        let files = applyFindInfoShape(Array.from(infos.values()), prefix, { shallow: config.shallow, type: config.type });
        sort(files, x => x.path);
        return files;
    }

    // All files changed after config.time — fast, straight from the in-memory index. Filters on when WE learned of the change (changedAt), so files synchronized late (with old write times) are still reported. Deletions ARE reported, as size-0 tombstone entries — that's how they propagate to stores syncing from us. config.routes lets a store syncing a partial shard ask for just its slice.
    public async getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]> {
        await this.init();
        await this.waitForRequiredScans();
        let inRoutes = (key: string) => !config.routes || config.routes.some(route => routeContains(route, getRoute(key)));
        let files: ArchiveFileInfo[] = [];
        for (let [key, entry] of this.mem) {
            if (entry.changedAt <= config.time) continue;
            if (this.overlay.has(key)) continue;
            if (!inRoutes(key)) continue;
            files.push({ path: key, createTime: entry.writeTime, size: entry.size });
        }
        for (let [key, overlayEntry] of this.overlay) {
            if (overlayEntry.t <= config.time) continue;
            if (!inRoutes(key)) continue;
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
            })).filter((x, i) => this.isLive(i)),
        };
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
            })).filter((x, i) => this.isLive(i)),
            readerDiskLimit: this.config?.readerDiskLimit,
            syncing: [...this.syncActivities],
        };
    }

    /** Walks the whole index for exact totals - more expensive than getSyncProgress, but immune to any drift in the maintained counters (and loads the index first, so it's never cold zeros). */
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
            let slot = this.slotForSourcesListIndex(entry.sourcesListIndex);
            if (slot !== undefined) {
                sources[slot].fileCount++;
                sources[slot].byteCount += entry.size;
            }
        }
        return { fileCount, byteCount, sources: sources.filter((x, i) => this.isLive(i)) };
    }

    /** Applies a config change to the RUNNING store: windows/routes update in place, new sources are added (their sync starts immediately), and removed sources' slots go dead (their scans stop, their index entries drop). The store survives every routine config evolution - it is never destroyed for a source-list change, only for structural flips it cannot express (rawDisk). Pending fast writes are re-capped to the new flush deadline (flushing immediately when it has already passed). */
    public updateSources(specs: BlobSourceSpec[], entries?: HostedConfig[]): void {
        if (!specs.length || specs[0].identity !== "disk") {
            throw new Error(`updateSources expects the disk source first (identity "disk"), got ${JSON.stringify(specs.map(x => x.identity))} (store ${this.folder})`);
        }
        if (entries) {
            this.entries = entries;
        }
        let setWindow = (i: number, window: [number, number]) => {
            let old = this.sources[i].validWindow;
            if (old[0] === window[0] && old[1] === window[1]) return;
            console.log(`Valid window changed for ${this.sources[i].source.getDebugName()} (store ${this.folder}): [${old.join(", ")}] -> [${window.join(", ")}]`);
            this.sources[i].validWindow = window;
        };
        setWindow(0, specs[0].validWindow);
        // Live slots pair with specs by identity, in order (the same endpoint can appear several times, e.g. one entry per window)
        let liveByIdentity = new Map<string, number[]>();
        let originalLength = this.sources.length;
        for (let i = 1; i < originalLength; i++) {
            if (!this.isLive(i)) continue;
            let id = this.sources[i].identity;
            if (id === undefined) continue;
            let list = liveByIdentity.get(id);
            if (!list) {
                list = [];
                liveByIdentity.set(id, list);
            }
            list.push(i);
        }
        let matched = new Set<number>();
        for (let spec of specs.slice(1)) {
            let slot = liveByIdentity.get(spec.identity)?.shift();
            if (slot !== undefined) {
                matched.add(slot);
                setWindow(slot, spec.validWindow);
                let existing = this.sources[slot];
                if (JSON.stringify(existing.route) !== JSON.stringify(spec.route)) {
                    console.log(`Route changed for ${existing.source.getDebugName()} (store ${this.folder}): ${JSON.stringify(existing.route)} -> ${JSON.stringify(spec.route)}`);
                    existing.route = spec.route;
                }
                existing.noFullSync = spec.noFullSync;
                continue;
            }
            let source = spec.create();
            this.sources.push({ source, url: spec.url, validWindow: spec.validWindow, route: spec.route, noFullSync: spec.noFullSync, intermediate: spec.intermediate, identity: spec.identity });
            this.sourceStates.push(newSourceState());
            this.sourceFileCounts.push(0);
            this.sourceByteCounts.push(0);
            console.log(`Added sync source ${source.getDebugName()} (store ${this.folder})`);
            if (this.syncStarted) {
                void this.runSourceSync(this.sources.length - 1);
            }
        }
        for (let i = 1; i < originalLength; i++) {
            if (!this.isLive(i) || matched.has(i)) continue;
            this.removeSource(i);
        }
        let deadline = this.sources[0].validWindow[1] - WINDOW_END_FLUSH_MARGIN;
        let recapped = 0;
        for (let entry of this.overlay.values()) {
            if (entry.flushAt <= deadline) continue;
            entry.flushAt = deadline;
            recapped++;
        }
        if (recapped) {
            console.log(`Re-capped ${recapped} pending fast writes to the new flush deadline ${new Date(deadline).toISOString()} (store ${this.folder})`);
            if (deadline <= Date.now()) {
                void this.flushOverlay().catch((e: Error) => console.error(`Flushing fast writes after a valid window change failed (store ${this.folder}): ${e.stack ?? e}`));
            }
        }
    }

    /** Rescans our own disk's metadata into the index - used around valid window handoffs, where another process wrote files to the shared folder that our index hasn't seen. */
    public async rescanBase(): Promise<void> {
        await this.init();
        await this.scanSource(0);
    }

    /** A boundary scan of the node that owned (part of) our route in the valid window before ours, when that node is different storage (a disk rescan can't see its writes): just its changes since the boundary neighborhood, with matching values pulled onto our own disk. */
    public async boundaryScanRemote(source: IArchives, config: { since: number; route?: [number, number] }): Promise<void> {
        await this.init();
        let scanStart = Date.now();
        console.log(`Boundary scan of ${source.getDebugName()} starting: changes since ${new Date(config.since).toISOString()}, route ${JSON.stringify(config.route || FULL_ROUTE)} (store ${this.folder})`);
        let changes = await source.getChangesAfter2({ time: config.since, routes: config.route && [config.route] || undefined });
        let tally = newScanTally();
        for (let file of changes) {
            if (file.path === ROUTING_FILE) {
                tally.filtered++;
                continue;
            }
            let overlayEntry = this.overlay.get(file.path);
            let entry = this.mem.get(file.path);
            let currentTime = overlayEntry && overlayEntry.t || entry && entry.writeTime || 0;
            if (file.createTime <= currentTime) {
                tally.unchanged++;
                continue;
            }
            if (file.size === 0) {
                // A tombstone stores nothing on our own source - the index entry alone records it
                this.setIndexEntry(file.path, { writeTime: file.createTime, size: 0, sourcesListIndex: this.sourcesListIndexOfSlot(0) });
                tally.tombstone++;
                continue;
            }
            let copied = await copyArchiveFile({ from: source, to: this.sources[0].source, path: file.path, size: file.size, writeTime: file.createTime, forceSetImmutable: true, noChecks: true, internal: true });
            if (!copied) continue;
            if (copied.size === 0) {
                this.setIndexEntry(file.path, { writeTime: copied.writeTime, size: 0, sourcesListIndex: this.sourcesListIndexOfSlot(0) });
                tally.tombstone++;
                continue;
            }
            this.setIndexEntry(file.path, { writeTime: copied.writeTime, size: copied.size, sourcesListIndex: this.sourcesListIndexOfSlot(0) });
            if (entry || overlayEntry) {
                tally.updated++;
            } else {
                tally.new++;
            }
        }
        console.log(`Boundary scan of ${source.getDebugName()} finished in ${Math.round((Date.now() - scanStart) / 1000)}s (store ${this.folder}): ${changes.length} changes: ${formatScanTally(tally, changes.length)}`);
    }

    // Large uploads stream onto the local disk source directly (they may not fit in memory)
    public async startLargeUpload(config?: { path?: string; lastModified?: number }): Promise<string> {
        await this.init();
        if (config?.path) {
            await this.assertMutable(config.path, config.lastModified || Date.now());
        }
        return await this.getDiskSource().disk.startLargeUpload();
    }
    public async appendLargeUpload(config: { id: string; data: Buffer }): Promise<void> {
        await this.getDiskSource().disk.appendLargeUpload(config.id, config.data);
    }
    public async finishLargeUpload(config: { id: string; path: string; lastModified?: number }): Promise<void> {
        let { disk, sourceIndex } = this.getDiskSource();
        await disk.finishLargeUpload(config.id, config.path, config.lastModified);
        this.overlay.delete(config.path);
        // includeTombstones: a zero-byte upload is still a real file whose index entry must be written
        let info = await disk.getInfo(config.path, { includeTombstones: true });
        if (info) {
            this.setIndexEntry(config.path, { writeTime: info.writeTime, size: info.size, sourcesListIndex: this.sourcesListIndexOfSlot(sourceIndex) });
        }
    }
    public async cancelLargeUpload(config: { id: string }): Promise<void> {
        await this.getDiskSource().disk.cancelLargeUpload(config.id);
    }

    // #endregion

    // #region Internals

    private stopped = { stop: false };

    // The index's BulkDatabase2 files live under <folder>/index. "blobIndex2": the "blobIndex" generation persisted sources-array positions as the holding source, which are not stable across runs - its entries are unusable, so it is simply never read again.
    private index = new BulkDatabaseBase<BlobIndexEntry>("blobIndex2", noopReactiveDeps, async (p: string) => {
        let base: DirectoryWrapper = new NodeJSDirectoryHandleWrapper(path.join(this.folder, "index"));
        for (let part of p.split("/")) {
            if (part) base = await base.getDirectoryHandle(part, { create: true });
        }
        return wrapHandle(base);
    });
    // The in-memory copy of the index. All reads are served from it; changes are buffered in dirty and flushed to the BulkDatabase2 in batches (undefined = delete).
    private mem = new Map<string, IndexEntry>();
    // Live totals over mem (tombstones excluded), adjusted on every mutation and recomputed on load - so any drift heals on restart. computeIndexTotals gives the walk-the-index truth.
    private indexFileCount = 0;
    private indexByteCount = 0;
    // The same totals per holding source (index 0 = our disk, which readerDiskLimit bounds)
    private sourceFileCounts = this.sources.map(() => 0);
    private sourceByteCounts = this.sources.map(() => 0);
    // Background scans / full syncs currently in progress (a Set - one source can have a change poll's full sync and a rescan overlapping)
    private syncActivities = new Set<SyncActivity>();
    private dirty = new Map<string, IndexEntry | undefined>();
    private overlay = new Map<string, OverlayEntry>();
    private sourceStates = this.sources.map(() => newSourceState());
    private syncStarted = false;
    private entries = this.config?.entries || [];
    // The persistent identities behind IndexEntry.sourcesListIndex (see SourcesList)
    private sourcesList = new SourcesList(path.join(this.folder, "index", "sourcesList.txt"));
    // Per slot: the persistent sourcesListIndex of that slot's URL, filled by registerSlot before the slot's sync runs
    private slotSourcesListIndexes: number[] = [];
    private slotRegistrations: Promise<void>[] = [];

    private isLive(sourceIndex: number): boolean {
        return !!this.sources[sourceIndex] && !this.sourceStates[sourceIndex].dead;
    }

    private registerSlot(slot: number): Promise<void> {
        let existing = this.slotRegistrations[slot];
        if (existing) return existing;
        let registration = this.sourcesList.ensure(this.sources[slot].url).then(index => {
            this.slotSourcesListIndexes[slot] = index;
        });
        this.slotRegistrations[slot] = registration;
        return registration;
    }

    // The persistent sourcesListIndex of a slot - only valid once the slot's registration resolved (init and runSourceSync guarantee that before any indexing happens)
    private sourcesListIndexOfSlot(slot: number): number {
        let index = this.slotSourcesListIndexes[slot];
        if (index === undefined) {
            throw new Error(`Source slot ${slot} (${this.sources[slot]?.url}) has no registered sourcesListIndex yet (store ${this.folder})`);
        }
        return index;
    }

    // The live slot currently serving a persistent sourcesListIndex, or undefined when no configured source has that URL anymore. Linear, but the sources list is tiny and this is always current (slots dying, or several slots sharing one URL across valid windows, need no bookkeeping).
    private slotForSourcesListIndex(sourcesListIndex: number): number | undefined {
        for (let i = 0; i < this.slotSourcesListIndexes.length; i++) {
            if (this.slotSourcesListIndexes[i] === sourcesListIndex && this.isLive(i)) return i;
        }
        return undefined;
    }

    // The IArchives currently holding an entry's bytes: the live slot when the holder is still configured, otherwise resolved (cached) straight from its persisted URL - windows/routes decide when a source is scanned or written, but for reading bytes we know it holds, the URL alone is enough
    private async getEntryHolder(entry: IndexEntry): Promise<IArchives | undefined> {
        let slot = this.slotForSourcesListIndex(entry.sourcesListIndex);
        if (slot !== undefined) return this.sources[slot].source;
        let url = this.sourcesList.getUrl(entry.sourcesListIndex) || await this.sourcesList.getUrlReloading(entry.sourcesListIndex);
        if (!url) return undefined;
        return this.config?.resolveSourceUrl?.(url);
    }

    private async loadIndex(): Promise<void> {
        let [writeTimes, sizes, sourcesListIndexes] = await Promise.all([
            this.index.getColumn("writeTime"),
            this.index.getColumn("size"),
            this.index.getColumn("sourcesListIndex"),
        ]);
        let sizeMap = new Map(sizes.map(x => [x.key, x.value]));
        let sourcesListIndexMap = new Map(sourcesListIndexes.map(x => [x.key, x.value]));
        for (let entry of writeTimes) {
            let size = sizeMap.get(entry.key);
            let sourcesListIndex = sourcesListIndexMap.get(entry.key);
            // Explicit checks, as 0 is a valid size and a valid sourcesListIndex
            if (size === undefined || sourcesListIndex === undefined) continue;
            // The routing config is only ever read off our own disk (see updateScanIndex), and a loaded bucket always has it there - a persisted entry pointing elsewhere is stale
            if (entry.key === ROUTING_FILE) {
                sourcesListIndex = this.sourcesListIndexOfSlot(0);
            }
            let full: IndexEntry = { writeTime: entry.value, size, sourcesListIndex, changedAt: entry.time, lastAccess: entry.time };
            this.mem.set(entry.key, full);
            this.countEntry(full, 1);
        }
    }

    private countEntry(entry: IndexEntry | undefined, direction: number): void {
        if (!entry || entry.size === 0) return;
        this.indexFileCount += direction;
        this.indexByteCount += entry.size * direction;
        // Entries can reference a source no longer configured (readable via getEntryHolder, but with no slot to count under)
        let slot = this.slotForSourcesListIndex(entry.sourcesListIndex);
        if (slot !== undefined) {
            this.sourceFileCounts[slot] += direction;
            this.sourceByteCounts[slot] += entry.size * direction;
        }
    }

    private setIndexEntry(key: string, entry: { writeTime: number; size: number; sourcesListIndex: number }): void {
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

    // The slot stays in the arrays forever (index entries reference sources by slot number); it just goes dead - loops stop, and its index entries drop (other sources' scans re-find any copy that's still reachable through the new config)
    private removeSource(sourceIndex: number): void {
        let state = this.sourceStates[sourceIndex];
        let source = this.sources[sourceIndex].source;
        state.dead = true;
        state.stopped.stop = true;
        state.scanComplete = true;
        state.initialScan.resolve(undefined);
        let sourcesListIndex = this.slotSourcesListIndexes[sourceIndex];
        // The same URL can be another live slot (one entry per valid window) - the endpoint is still configured, so its entries stay
        if (sourcesListIndex !== undefined && this.slotForSourcesListIndex(sourcesListIndex) === undefined) {
            let dropped = 0;
            for (let [key, entry] of this.mem) {
                if (entry.sourcesListIndex !== sourcesListIndex) continue;
                this.deleteIndexEntry(key);
                dropped++;
            }
            console.log(`Removed sync source ${source.getDebugName()} (store ${this.folder}): its scans are stopped and ${dropped} index entries it held were dropped`);
            return;
        }
        console.log(`Removed sync source ${source.getDebugName()} (store ${this.folder}): its scans are stopped (its URL is still served by another slot, so its index entries stay)`);
    }

    private async flushIndex(): Promise<void> {
        if (!this.dirty.size) return;
        let dirty = this.dirty;
        this.dirty = new Map();
        let writes: BlobIndexEntry[] = [];
        let deletes: string[] = [];
        for (let [key, entry] of dirty) {
            if (entry) {
                writes.push({ key, writeTime: entry.writeTime, size: entry.size, sourcesListIndex: entry.sourcesListIndex });
            } else {
                deletes.push(key);
            }
        }
        if (writes.length) await this.index.writeBatch(writes);
        if (deletes.length) await this.index.deleteBatch(deletes);
    }

    // ── validation (from this store's own routing entries) ──

    private async assertMutable(key: string, writeTime: number): Promise<void> {
        if (!this.entries.length) return;
        let self = selectEntryAt(this.entries, writeTime, getRoute(key));
        if (!self?.immutable) return;
        if (await this.getInfo({ path: key })) {
            throw new Error(`This store is immutable (at write time ${writeTime}) and ${JSON.stringify(key)} already exists, so it cannot be written to (store ${this.folder})`);
        }
    }

    // See SetConfig.internal: the stamp must land inside SOME window+route this store is configured for (any window, including past ones - synchronization moves old data), so a confused peer can't stuff data onto a store that was never meant to hold it
    private assertInternalWriteAccepted(key: string, writeTime: number, route: number): void {
        if (!this.entries.length) return;
        let covered = this.entries.some(x => writeTime >= x.validWindow[0] && writeTime < x.validWindow[1] && routeContains(x.route, route));
        if (!covered) {
            throw new Error(`Internal write of ${JSON.stringify(key)} rejected: writeTime ${writeTime} (${new Date(writeTime).toISOString()}) at route ${route} is outside every window/route this store is configured for: ${JSON.stringify(this.entries.map(x => ({ validWindow: x.validWindow, route: x.route || FULL_ROUTE })))} (store ${this.folder})`);
        }
    }

    // ── synchronization ──

    private async runSourceSync(sourceIndex: number): Promise<void> {
        await this.registerSlot(sourceIndex);
        let { source } = this.sources[sourceIndex];
        let state = this.sourceStates[sourceIndex];
        // Read live for every pass, not captured - updateSources can change it while loops run
        let noFullSync = () => this.sources[sourceIndex].noFullSync;
        let intermediate = this.sources[sourceIndex].intermediate;
        let listing: Map<string, number> | undefined;
        while (!this.stopped.stop && !state.stopped.stop) {
            if (this.isDeadIntermediate(sourceIndex)) {
                console.log(`Not scanning sync source ${source.getDebugName()} (store ${this.folder}): it is an intermediate whose window already ended`);
                break;
            }
            try {
                let config = await source.getConfig();
                state.supportsChangesAfter = !!config.supportsChangesAfter;
                listing = await this.scanSource(sourceIndex);
                break;
            } catch (e) {
                if (intermediate) {
                    console.error(`Initial scan of intermediate sync source ${source.getDebugName()} (store ${this.folder}) failed; not retrying (intermediates are temporary switchover ports): ${(e as Error).stack ?? e}`);
                    break;
                }
                console.error(`Initial scan of sync source ${source.getDebugName()} failed, retrying:`, e);
                await delay(SCAN_RETRY_DELAY);
            }
        }
        state.scanComplete = true;
        state.initialScan.resolve(undefined);
        if (this.stopped.stop || state.stopped.stop) return;
        // An intermediate that never produced a listing is dead or dying - polling and copying from it would only log errors
        if (intermediate && !listing) return;
        if (listing) {
            await this.reconcileSource(sourceIndex, listing);
        }
        if (!noFullSync()) {
            try {
                await this.copySourceFiles(sourceIndex);
            } catch (e) {
                console.error(`Copying files from sync source ${source.getDebugName()} failed:`, e);
            }
        }
        if (state.supportsChangesAfter) {
            runInfinitePoll(CHANGES_POLL_INTERVAL, async () => {
                if (this.isDeadIntermediate(sourceIndex)) return;
                await this.pollChanges(sourceIndex);
                if (!noFullSync()) await this.copySourceFiles(sourceIndex);
            }, state.stopped);
            // Change polls only show what the source HAS, never what it's missing, so pushes run on the full-rescan cadence (findInfo on an index-backed source is cheap)
            runInfinitePoll(FULL_RESCAN_INTERVAL, async () => {
                if (this.isDeadIntermediate(sourceIndex)) return;
                let files = await source.findInfo("");
                await this.reconcileSource(sourceIndex, new Map(files.map(x => [x.path, x.createTime])));
            }, state.stopped);
        } else {
            runInfinitePoll(FULL_RESCAN_UNINDEXED_INTERVAL, async () => {
                if (this.isDeadIntermediate(sourceIndex)) return;
                let rescan = await this.scanSource(sourceIndex);
                await this.reconcileSource(sourceIndex, rescan);
                if (!noFullSync()) await this.copySourceFiles(sourceIndex);
            }, state.stopped);
        }
    }

    // An intermediate is a deploy switchover's temporary alternate port: once its window is past, the port is gone for good, so scanning it (or retrying a failed scan) can never succeed - it would just log errors forever
    private isDeadIntermediate(sourceIndex: number): boolean {
        let { intermediate, validWindow } = this.sources[sourceIndex];
        return !!intermediate && validWindow[1] <= Date.now();
    }

    // Full metadata scan (size, writeTime, path) of one source, applied to the index. Returns the source's listing (path -> write time), which reconcileSource uses for the push direction.
    private async scanSource(sourceIndex: number): Promise<Map<string, number>> {
        let { source, route } = this.sources[sourceIndex];
        let state = this.sourceStates[sourceIndex];
        let scanStart = Date.now();
        let activity: SyncActivity = { type: "metadataScan", sourceDebugName: source.getDebugName(), startTime: scanStart };
        this.syncActivities.add(activity);
        console.log(`Metadata scan of ${source.getDebugName()} starting (store ${this.folder})`);
        let progressTimer = setInterval(() => {
            console.log(`Metadata scan of ${source.getDebugName()} still running (${Math.round((Date.now() - scanStart) / 1000)}s, store ${this.folder})`);
        }, SYNC_PROGRESS_LOG_INTERVAL);
        (progressTimer as { unref?: () => void }).unref?.();
        // The listing request deliberately takes no time or route filters: our slowest sources (backblaze) support neither, so filtering would happen after the full fetch anyway - little benefit, more room for desynchronization. And if a full listing ever becomes too big to send over the network, it is also too big for the receiving process to hold in memory - the fix is more routing shards (each storing and sending less), not filtering.
        let files: ArchiveFileInfo[];
        try {
            files = await source.findInfo("");
        } finally {
            clearInterval(progressTimer);
            this.syncActivities.delete(activity);
        }
        // The source may have been removed while the listing was in flight; its results are dead
        if (state.stopped.stop) return new Map();
        let indexSizeBefore = this.mem.size;
        let seen = new Map<string, number>();
        let tally = newScanTally();
        let newPaths = 0;
        for (let file of files) {
            seen.set(file.path, file.createTime);
            if (!this.mem.has(file.path)) {
                newPaths++;
            }
            tally[this.updateScanIndex(sourceIndex, file)]++;
        }
        state.scannedCount = files.length;
        // Index entries this source was the holder of, but that vanished from it (e.g. deleted while we were offline), come out of the index. Entries changed after the scan started are kept — the scan listing may simply predate them. Tombstones have no physical file for a listing to vouch for, so they're exempt (cleanupTombstones expires them instead).
        let removedFromIndex = 0;
        let missingOnSource = 0;
        let scannedSourcesListIndex = this.sourcesListIndexOfSlot(sourceIndex);
        for (let [key, entry] of this.mem) {
            if (seen.has(key)) continue;
            if (entry.sourcesListIndex === scannedSourcesListIndex && entry.size !== 0 && entry.changedAt < scanStart) {
                this.deleteIndexEntry(key);
                removedFromIndex++;
                continue;
            }
            // Counted only when the source SHOULD hold the entry (its route matches) - these are what the reconcile pass pushes to it (which also ignores the valid window: synchronization moves existing values, the window only routes fresh writes)
            if (entry.size === 0 || key === ROUTING_FILE) continue;
            if (!routeContains(route, getRoute(key))) continue;
            missingOnSource++;
        }
        // Percentages are of the union of both sides (our index + their listing), so every count has a stable denominator
        let union = indexSizeBefore + newPaths;
        let pct = (n: number) => `${Math.round(n / Math.max(union, 1) * 1000) / 10}%`;
        console.log(`Metadata scan of ${source.getDebugName()} finished in ${Math.round((Date.now() - scanStart) / 1000)}s (store ${this.folder}): ${files.length} listed vs ${indexSizeBefore} indexed (union ${union}): ${formatScanTally(tally, union)}, ${missingOnSource} in index but missing on source (${pct(missingOnSource)}), ${removedFromIndex} removed from index (${pct(removedFromIndex)})`);
        state.changesAfterTime = Math.max(state.changesAfterTime, scanStart - CHANGES_POLL_OVERLAP);
        return seen;
    }

    // The push direction of synchronization: everything we know that the source is missing (or holds an older copy of) is written to it — including deletions, as tombstone writes. This is what heals a source whose background writes failed (e.g. it was down): the next scan sees what's missing and re-sends it. A failing file is skipped, not fatal (immutable targets are handled by forceSetImmutable, and one unreadable value must not stop the rest of the pass) - only a run of consecutive failures (the source itself is down) aborts until the next scan cycle.
    private async reconcileSource(sourceIndex: number, listing: Map<string, number>): Promise<void> {
        let { source, validWindow, route } = this.sources[sourceIndex];
        let state = this.sourceStates[sourceIndex];
        let acceptsWrites = windowAcceptsWrites(validWindow);
        let targetSourcesListIndex = this.sourcesListIndexOfSlot(sourceIndex);
        let pushed = 0;
        let failed = 0;
        let consecutiveFailures = 0;
        let errors: string[] = [];
        let aborted = false;
        for (let [key, entry] of this.mem) {
            if (this.stopped.stop || state.stopped.stop) return;
            if (entry.sourcesListIndex === targetSourcesListIndex) continue;
            // The routing file is NEVER synchronized between storage nodes - it is only ever written directly to each node, and only ever read off our own disk
            if (key === ROUTING_FILE) continue;
            if (!acceptsWrites) continue;
            if (!routeContains(route, getRoute(key))) continue;
            let theirTime = listing.get(key);
            if (theirTime !== undefined && theirTime >= entry.writeTime) continue;
            try {
                if (entry.size === 0) {
                    // A deletion only needs pushing while the source still holds an older copy. It travels as del (never as an empty set - set rejects empty buffers), with the ORIGINAL deletion time so ordering survives.
                    if (theirTime === undefined) continue;
                    await source.del(key, { lastModified: entry.writeTime, noChecks: true, internal: true });
                    pushed++;
                    consecutiveFailures = 0;
                    continue;
                }
                let holder = await this.getEntryHolder(entry);
                if (!holder) continue;
                let copied = await copyArchiveFile({ from: holder, to: source, path: key, size: entry.size, writeTime: entry.writeTime, forceSetImmutable: true, noChecks: true, internal: true });
                if (!copied) continue;
                pushed++;
                consecutiveFailures = 0;
            } catch (e) {
                failed++;
                consecutiveFailures++;
                if (errors.length < RECONCILE_ERROR_LOG_LIMIT) {
                    errors.push(`${key}: ${(e as Error).stack ?? e}`);
                }
                if (consecutiveFailures >= RECONCILE_MAX_CONSECUTIVE_FAILURES) {
                    aborted = true;
                    break;
                }
            }
        }
        if (failed) {
            console.error(`Reconciling sync source ${source.getDebugName()} (store ${this.folder}): pushed ${pushed} files, ${failed} failed${aborted && ` before aborting the pass (${consecutiveFailures} consecutive failures - the source looks down; the next scan cycle retries)` || ""}. First errors: ${errors.join(" | ")}`);
        } else if (pushed) {
            console.log(`Reconciled sync source ${source.getDebugName()} (store ${this.folder}): pushed ${pushed} files it was missing or held older copies of`);
        }
    }

    private updateScanIndex(sourceIndex: number, file: ArchiveFileInfo): ScanOutcome {
        // An in-flight scan can outlive its source's removal; its results are dead
        if (!this.isLive(sourceIndex)) return "filtered";
        if (file.path === ROUTING_FILE) {
            // The routing config is NEVER pulled from other sources - it only ever arrives as an explicit, version-validated write, and is only ever read off our own disk. Route and valid-window filters can't possibly apply to it either: it is the file DEFINING them, so filtering it would mean certain sources could never have their routing config updated, ever.
            if (sourceIndex !== 0) return "filtered";
        } else {
            // The valid window is deliberately NOT applied here: it decides where WRITES route, but a scan is us asking a source what it already holds - existing values synchronize regardless of the window (the same reasoning that lets synchronization ignore the immutable flag). Only the route filters: a partially-overlapping shard's listing legitimately includes keys that aren't ours.
            let { route } = this.sources[sourceIndex];
            if (!routeContains(route, getRoute(file.path))) return "filtered";
        }
        let existing = this.mem.get(file.path);
        // The highest write time wins across all sources (ties keep the existing entry)
        if (existing && file.createTime <= existing.writeTime) return "unchanged";
        this.setIndexEntry(file.path, { writeTime: file.createTime, size: file.size, sourcesListIndex: this.sourcesListIndexOfSlot(sourceIndex) });
        if (file.size === 0) return "tombstone";
        if (existing) return "updated";
        return "new";
    }

    private async pollChanges(sourceIndex: number): Promise<void> {
        let { source, route } = this.sources[sourceIndex];
        let state = this.sourceStates[sourceIndex];
        let pollStart = Date.now();
        let changes = await source.getChangesAfter2({ time: state.changesAfterTime, routes: route && [route] || undefined });
        let tally = newScanTally();
        for (let file of changes) {
            tally[this.updateScanIndex(sourceIndex, file)]++;
        }
        // Polls run constantly, so only the ones that actually changed the index get a line
        if (tally.new || tally.updated || tally.tombstone) {
            console.log(`Changes poll of ${source.getDebugName()} (store ${this.folder}): ${changes.length} changes: ${formatScanTally(tally, changes.length)}`);
        }
        state.scannedCount += changes.length;
        state.changesAfterTime = pollStart - CHANGES_POLL_OVERLAP;
    }

    // Downloads the files a source currently holds onto our own base source (the local disk), preserving their modified times — so a newer local write always wins. Skipped for noFullSync sources (fronting a large database without copying it); reads still down-cache lazily.
    private async copySourceFiles(sourceIndex: number): Promise<void> {
        if (sourceIndex === 0) return;
        let { source } = this.sources[sourceIndex];
        let state = this.sourceStates[sourceIndex];
        let pending: { key: string; entry: IndexEntry }[] = [];
        let totalBytes = 0;
        let copiedSourcesListIndex = this.sourcesListIndexOfSlot(sourceIndex);
        for (let [key, entry] of this.mem) {
            if (entry.sourcesListIndex !== copiedSourcesListIndex) continue;
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
                while (!failed && !this.stopped.stop && !state.stopped.stop) {
                    let index = nextIndex++;
                    if (index >= pending.length) return;
                    let { key, entry } = pending[index];
                    let copied = await copyArchiveFile({ from: source, to: this.sources[0].source, path: key, size: entry.size, writeTime: entry.writeTime, forceSetImmutable: true, noChecks: true, internal: true });
                    if (copied) {
                        // Only move the entry's source if it wasn't changed while we copied
                        if (this.mem.get(key) === entry) {
                            this.setIndexEntry(key, { writeTime: copied.writeTime, size: copied.size, sourcesListIndex: this.sourcesListIndexOfSlot(0) });
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

    // findInfo and getChangesAfter2 list from the index, so they must wait for our own base source's initial scan (which might lag minutes) before the listing is trustworthy. The base (local disk) is implicitly required - remote sources are not, they come and go.
    private async waitForRequiredScans(): Promise<void> {
        await this.sourceStates[0].initialScan.promise;
    }

    // A requested file isn't in the index: our own base source (implicitly required) is checked directly if its initial scan hasn't finished, and changes-after sources are re-polled (at most every 5 seconds)
    private async checkMissingKey(key: string): Promise<void> {
        for (let i = 0; i < this.sources.length; i++) {
            if (!this.isLive(i)) continue;
            let { source } = this.sources[i];
            let state = this.sourceStates[i];
            if (i === 0 && !state.scanComplete) {
                // includeTombstones: a deletion on disk (an empty file) must be ingested as a tombstone, write time included
                let info = await source.getInfo(key, { includeTombstones: true });
                if (info) {
                    this.updateScanIndex(i, { path: key, createTime: info.writeTime, size: info.size });
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
        // An entry whose holder is no longer in the source list is still valid - getEntryHolder resolves the persisted URL directly (and get2's fallback loop covers a holder that is gone entirely)
        let entry = this.mem.get(key);
        if (entry) return entry;
        await this.checkMissingKey(key);
        return this.mem.get(key);
    }

    /** Internal (store-to-store) read: purely the local disk, completely short-circuiting the index and holder resolution - the caller is another store, and chasing OUR remote holders while answering it is how infinite get loops between stores form. No window or route checks: if the bytes are on our disk, the caller may have them. Note fast writes still sitting in the overlay are invisible here; the caller re-finds them after our flush. */
    private async getInternal2(config: { path: string; range?: { start: number; end: number }; includeTombstones?: boolean }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        await this.init();
        // includeTombstones forwards to the disk: a flag-caller (a peer store's synchronization) needs to see our deletions, not just our content. A tombstone deleted from disk entirely only lives in our index, so fall back to that.
        let result = await this.getDiskSource().disk.get2(config.path, { range: config.range, includeTombstones: config.includeTombstones });
        if (!result || !result.data) {
            if (config.includeTombstones) {
                let entry = this.mem.get(config.path);
                if (entry && !entry.size) return { data: Buffer.alloc(0), writeTime: entry.writeTime, size: 0 };
            }
            return undefined;
        }
        return { data: result.data, writeTime: result.writeTime, size: result.size };
    }

    /** Internal (store-to-store) write: the local disk plus our index, with NO downstream fan-out - the pushing store owns propagation, and fanning its pushes back out is how write loops between stores form. Only-take-latest still applies here. */
    private async setInternal(key: string, data: Buffer, config: { lastModified: number }): Promise<void> {
        await this.init();
        assertValidLastModified(config.lastModified);
        let overlayEntry = this.overlay.get(key);
        let entry = this.mem.get(key);
        let currentTime = overlayEntry && overlayEntry.t || entry && entry.writeTime || 0;
        if (config.lastModified < currentTime) return;
        if (data.length === 0) {
            // A tombstone stores nothing on our own source - the index entry alone records it
            await this.sources[0].source.del(key);
        } else {
            await this.sources[0].source.set(key, data, { lastModified: config.lastModified, forceSetImmutable: true, noChecks: true });
        }
        this.setIndexEntry(key, { writeTime: config.lastModified, size: data.length, sourcesListIndex: this.sourcesListIndexOfSlot(0) });
    }

    // The read's bytes came from a remote source, so write them onto our own base source (the local disk), which becomes the entry's new holder - reads only pay the remote fetch once
    private async cacheRead(key: string, result: { data: Buffer; writeTime: number }): Promise<void> {
        await this.sources[0].source.set(key, result.data, { lastModified: result.writeTime, forceSetImmutable: true, noChecks: true });
        this.setIndexEntry(key, { writeTime: result.writeTime, size: result.data.length, sourcesListIndex: this.sourcesListIndexOfSlot(0) });
    }

    // The shared engine of set and del: an empty buffer is exactly a deletion here, which is why the empty-buffer rejection lives in set (the public API), not in this machinery
    private async setOrDelete(key: string, data: Buffer, config: { fast?: boolean; writeDelay?: number; lastModified?: number }): Promise<void> {
        this.config?.onWriteCounted?.("original", data.length);
        let lastModified = config.lastModified;
        if (lastModified) {
            assertValidLastModified(lastModified);
            let overlayEntry = this.overlay.get(key);
            let entry = this.mem.get(key);
            let currentTime = overlayEntry && overlayEntry.t || entry && entry.writeTime || 0;
            // An older write never overwrites a newer one (see IArchives.set)
            if (lastModified < currentTime) return;
        }
        let writeTime = lastModified || Date.now();
        if (config.fast) {
            // A writeDelay of zero is a real choice (no delay at all), so only an omitted delay gets the default
            let writeDelay = config.writeDelay;
            if (writeDelay === undefined) {
                writeDelay = DEFAULT_FAST_WRITE_DELAY;
            }
            // The delay never extends past our own valid window's end (minus the margin, so the writes are on disk before the next window's source takes over - a deploy switchover is just this too, since its remap ends our window). Past that point fast writes write through immediately.
            let deadline = this.sources[0].validWindow[1] - WINDOW_END_FLUSH_MARGIN;
            if (writeDelay > 0 && Date.now() < deadline) {
                let flushAt = Math.min(Date.now() + writeDelay, deadline);
                this.overlay.set(key, { data, t: writeTime, flushAt });
                return;
            }
        }
        this.overlay.delete(key);
        await this.writeToSources(key, data, writeTime);
    }

    private getWritableSources(config?: { ignoreWindow?: boolean }): number[] {
        let writable: number[] = [];
        for (let i = 0; i < this.sources.length; i++) {
            if (!this.isLive(i)) continue;
            if (!config?.ignoreWindow && !windowAcceptsWrites(this.sources[i].validWindow)) continue;
            writable.push(i);
        }
        return writable;
    }

    private async writeToSources(key: string, data: Buffer, writeTime: number): Promise<void> {
        // The routing file is NEVER synchronized between storage nodes: the writer writes it directly to each node, so we store it on our own disk only (no valid-window filter - routing/valid windows can't possibly apply to the file defining them) and never forward it to other sources.
        this.config?.onWriteCounted?.("flushed", data.length);
        let isRouting = key === ROUTING_FILE;
        let writable = this.getWritableSources({ ignoreWindow: isRouting });
        let first = writable.shift();
        if (first === undefined) {
            throw new Error(`No source accepts writes (every source's valid window is in the past), so writes cannot be stored (store ${this.folder})`);
        }
        // Only our own (first) source blocks the write. Downstream sources are written in the background: a down downstream source must not fail or stall writes, and reconcileSource re-sends anything they missed once they come back.
        if (data.length === 0) {
            // A tombstone stores nothing on our own source - the index entry alone records it
            await this.sources[first].source.del(key);
        } else {
            await this.sources[first].source.set(key, data, { lastModified: writeTime, noChecks: true });
        }
        this.setIndexEntry(key, { writeTime, size: data.length, sourcesListIndex: this.sourcesListIndexOfSlot(first) });
        if (isRouting) return;
        let route = getRoute(key);
        for (let i of writable) {
            if (!routeContains(this.sources[i].route, route)) continue;
            // Deletions travel as del carrying the original write time (never as empty sets - set rejects empty buffers). Backblaze materializes such dels as real empty files, so its listings still show the deletion for other stores to scan in as a tombstone.
            let push: Promise<unknown>;
            if (data.length === 0) {
                push = this.sources[i].source.del(key, { lastModified: writeTime, noChecks: true, internal: true });
            } else {
                push = this.sources[i].source.set(key, data, { lastModified: writeTime, forceSetImmutable: true, noChecks: true, internal: true });
            }
            void push.catch((e: Error) => {
                console.error(`Background write of ${key} to sync source ${this.sources[i].source.getDebugName()} failed: ${e.stack ?? e}`);
            });
        }
    }

    private getDiskSource(): { disk: ArchivesDisk; sourceIndex: number } {
        for (let i = 0; i < this.sources.length; i++) {
            let source = this.sources[i].source;
            if (source instanceof ArchivesDisk) return { disk: source, sourceIndex: i };
        }
        throw new Error(`Large uploads require an ArchivesDisk source, and this store has none (store ${this.folder})`);
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

    // readerDiskLimit: the disk is only a bounded read cache, so once it exceeds the limit, the least recently used files are deleted from it - but ONLY when another source verifiably holds a same-or-newer copy (the only copy of a file is never deleted), and the index entry repoints to that source so reads keep working (re-caching on the next read).
    private evicting = false;
    private async enforceDiskLimit(): Promise<void> {
        let limit = this.config?.readerDiskLimit;
        if (!limit || this.evicting) return;
        if (this.sourceByteCounts[0] <= limit) return;
        this.evicting = true;
        let evictedFiles = 0;
        let evictedBytes = 0;
        try {
            let baseSourcesListIndex = this.sourcesListIndexOfSlot(0);
            let candidates: { key: string; entry: IndexEntry }[] = [];
            for (let [key, entry] of this.mem) {
                if (entry.sourcesListIndex !== baseSourcesListIndex || entry.size === 0 || key === ROUTING_FILE) continue;
                candidates.push({ key, entry });
            }
            sort(candidates, x => x.entry.lastAccess);
            for (let { key, entry } of candidates) {
                if (this.stopped.stop) return;
                if (this.sourceByteCounts[0] <= limit) break;
                if (this.mem.get(key) !== entry) continue;
                let holder: number | undefined;
                for (let i = 1; i < this.sources.length; i++) {
                    if (!this.isLive(i)) continue;
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
                this.setIndexEntry(key, { writeTime: entry.writeTime, size: entry.size, sourcesListIndex: this.sourcesListIndexOfSlot(holder) });
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

    // Tombstones only need to exist long enough for every store to learn of the deletion; expired ones come out of the index. The physical empty file is removed only on backblaze sources: remote stores expire their own tombstones (a del there would just mint a fresh one), and our own disk never stored anything for it.
    private async cleanupTombstones(): Promise<void> {
        let cutoff = Date.now() - TOMBSTONE_EXPIRY;
        for (let [key, entry] of this.mem) {
            if (this.stopped.stop) return;
            if (entry.size !== 0) continue;
            if (entry.writeTime > cutoff) continue;
            this.deleteIndexEntry(key);
            for (let i = 0; i < this.sources.length; i++) {
                if (!this.isLive(i)) continue;
                let sourceEntry = this.sources[i];
                if (!windowAcceptsWrites(sourceEntry.validWindow)) continue;
                let source = sourceEntry.source;
                if (!(source instanceof ArchivesBackblaze)) continue;
                void source.del(key).catch((e: Error) => {
                    console.error(`Removing expired tombstone ${key} from ${source.getDebugName()} failed: ${e.stack ?? e}`);
                });
            }
        }
    }

    // #endregion
}
