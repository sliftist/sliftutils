import { runInfinitePoll, delay, runInfinitePollCallAtStart, runInSerial } from "socket-function/src/batching";
import { cache } from "socket-function/src/caching";
import { timeInMinute, sort, promiseObj } from "socket-function/src/misc";
import { formatNumber, formatTime, formatDateTimeDetailed } from "socket-function/src/formatting/format";
import {
    IArchives, ArchiveFileInfo, ArchivesSyncStatus, SyncActivity, FULL_ROUTE,
    windowsAcceptWrites,
} from "../IArchives";
import { copyArchiveFile } from "../archiveHelpers";
import { ArchivesBackblaze } from "../backblaze";
import { ROUTING_FILE, getRoute, routeContains, parseRoutingData, getConfigVersion } from "./remoteConfig";
import type { BlobStore, IndexEntry } from "./blobStore";
import { getHistoryFactor, HISTORY_MIN_BYTES } from "./blobStore";
import { logSyncEvent } from "./storageLogs";
import { magenta } from "socket-function/src/formatting/logColors";

// Everything that keeps a store's index in agreement with its sources, plus the two maintenance loops that follow from holding an index (evicting a bounded disk cache, expiring tombstones). The store owns the sources and decides where writes go; this decides what is scanned, pulled, pushed, evicted, and forgotten - so the write path stays readable without the several hundred lines of synchronization machinery interleaved into it.

// Sources with a native (index-backed) change feed are polled this often
const CHANGES_POLL_INTERVAL = 1000 * 60;
// The routing config is checked for on every peer this often - far more often than a full rescan, because it is the file that decides what everything else does, and it is one small read per peer
const CONFIG_POLL_INTERVAL = 1000 * 60 * 5;
// Full metadata rescans. supportsChangesAfter is the heuristic for "one of our own storage servers": their index-backed listings are cheap, so hourly is fine. Everything else (backblaze, plain disk) pays the full listing cost, so it rescans much less often.
const FULL_RESCAN_INTERVAL = 1000 * 60 * 60;
const FULL_RESCAN_NON_REMOTE_INTERVAL = 1000 * 60 * 60 * 6;
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
// Reconcile passes AND full syncs skip failing files (one bad value must not stop the rest - a source failing one request in a thousand could otherwise never finish a sync), but this many failures in a row means the other side itself is down, so the pass aborts until the next cycle
const SYNC_MAX_CONSECUTIVE_FAILURES = 5;
const SYNC_ERROR_LOG_LIMIT = 3;
// Every failed file waits this long before the pass continues, so a down network burns through the consecutive-failure allowance over a minute-plus instead of in an instant
const SYNC_FAILURE_DELAY = 1000 * 15;
// A full listing that comes back EMPTY - or under half of what we know the source holds - is treated as the other end being briefly broken, not as the truth: it is retried this many times, this far apart, before being believed. Believing a wrongly-shrunken listing purges every index entry the source held, which is how sync progress "goes backwards".
const SUSPICIOUS_SCAN_RETRIES = 3;
const SUSPICIOUS_SCAN_RETRY_DELAY = 1000 * 60;
// How long past the end of a source's last window we are still willing to read (scan) it. We can't read from a source that's too old, because our tombstones only last so long (TOMBSTONE_EXPIRY): a source whose windows are all past never receives deletions (the window gates writes, deletions included), so it never knew about our tombstones - and if we read it after a tombstone expires, it can resurrect a dead value. While we DO read it, our own tombstone is what refutes its stale listings, so this duration must stay far below TOMBSTONE_EXPIRY.
const PAST_READ_DURATION = 1000 * 60 * 60;

type SourceState = {
    supportsChangesAfter: boolean;
    initialScan: ReturnType<typeof promiseObj>;
    scanComplete: boolean;
    // Whether a scan of this source has ever actually SUCCEEDED - what full syncs gate on: without one, the index's view of this source can be arbitrarily stale (e.g. it was restarting when we first tried), and syncing from stale information churns forever
    scanSucceeded: boolean;
    // Files seen in this source's scans / change polls so far
    scannedCount: number;
    // Watermark for getChangesAfter2 polls
    changesAfterTime: number;
    // Per-slot stop token: a removed source's loops stop without touching the rest of the store
    stopped: { stop: boolean };
    // A removed source's slot stays in the arrays (they are never spliced, so slot numbers held by running loops stay meaningful), marked dead - never scanned, written, or read. Index entries don't reference slots at all; they persist the sources list's sourcesListIndex.
    dead?: boolean;
};

function newSourceState(): SourceState {
    return {
        supportsChangesAfter: false,
        initialScan: promiseObj(),
        scanComplete: false,
        scanSucceeded: false,
        scannedCount: 0,
        changesAfterTime: 0,
        stopped: { stop: false },
    };
}

// What a scanned listing entry meant when compared against our index
type ScanOutcome = "filtered" | "new" | "updated" | "tombstone" | "unchanged";
type ScanTally = Record<ScanOutcome, number>;
function newScanTally(): ScanTally {
    return { filtered: 0, new: 0, updated: 0, tombstone: 0, unchanged: 0 };
}

export class StoreSync {
    // Per source slot, in step with the store's sources array. Slots are never spliced out - a removed one is marked dead - so a slot number held by a running loop always means the same source.
    private states: SourceState[];
    // Scans / full syncs in progress (a Set - one source can have a change poll's full sync and a rescan overlapping)
    private activities = new Set<SyncActivity>();
    // Guards against a second eviction pass starting while one is still walking the index
    private evicting = false;
    // When each key was last served, for readerDiskLimit's LRU eviction. Never persisted (a restart has no opinion about recency), and only kept for keys that have actually been read - an index entry no one has touched falls back to when we last changed it.
    private lastAccess = new Map<string, number>();

    constructor(private store: BlobStore) {
        this.states = store.sources.map(() => newSourceState());
    }

    /** Starts every live source's synchronization, plus the maintenance loops. Called once, by the store's init - the store's index must already be loaded, since scans write straight into it. */
    public start(): void {
        for (let i = 0; i < this.store.sources.length; i++) {
            if (!this.isLive(i)) continue;
            void this.startSourceSyncLoops(i);
        }
        runInfinitePoll(CONFIG_POLL_INTERVAL, () => this.pollRoutingConfig(), this.store.stopped);
        runInfinitePoll(TOMBSTONE_CLEANUP_INTERVAL, () => this.cleanupTombstones(), this.store.stopped);
        runInfinitePoll(TOMBSTONE_CLEANUP_INTERVAL, () => this.enforceHistoryLimit(), this.store.stopped);
        // Read live: the limit comes from the config, so a store that gains one later starts enforcing it without being restarted
        runInfinitePoll(DISK_LIMIT_CHECK_INTERVAL, () => this.enforceDiskLimit(), this.store.stopped);
    }

    /**
     * Asks every peer for the routing config, and takes it if it is newer than ours. This is the whole
     * of configuration propagation: it rides beside the scans rather than being part of them, because
     * one small read is worth doing every few minutes while a full listing is not, and because a
     * config we are missing is what stops everything else from being right.
     *
     * The copy is stored the same way a scan stores anything it pulls - an internal write into our own
     * store - and the store notices that file landing and re-configures itself. Nothing here knows what
     * a config means; it only knows this one file is worth asking for often.
     */
    private async pollRoutingConfig(): Promise<void> {
        for (let i = 1; i < this.store.sources.length; i++) {
            if (!this.isLive(i)) continue;
            if (this.store.sources[i].intermediate) continue;
            let { source } = this.store.sources[i];
            try {
                let theirs = await source.get2(ROUTING_FILE, { internal: true });
                if (!theirs || !theirs.data || !theirs.data.length) continue;
                let theirRouting = parseRoutingData(theirs.data);
                if (!theirRouting) continue;
                let version = getConfigVersion(theirRouting);
                if (version <= this.store.routingVersion()) continue;
                console.log(`Routing config version ${version} found on ${source.getDebugName()} (we have ${this.store.routingVersion()}, store ${this.store.folder}): taking it`);
                // Stamped NOW, not with their write time: configs are ordered by version, and this one is newer by that ordering. Their file can easily be older by write time (ours was rewritten locally more recently), and the store's only-take-the-latest rule would then drop it - leaving us finding the same newer version on every poll and never adopting it.
                await this.store.set({ path: ROUTING_FILE, data: theirs.data, lastModified: Date.now(), internal: true });
            } catch (e) {
                // A peer that cannot answer is the normal case for a source that is down; the next poll asks again
                console.error(`Checking ${source.getDebugName()} for a newer routing config failed (store ${this.store.folder}): ${(e as Error).stack ?? e}`);
            }
        }
    }

    /** Stops every source's loops (the store's own stop token stops the maintenance loops). */
    public stop(): void {
        for (let state of this.states) {
            state.stopped.stop = true;
        }
    }

    /** A slot the store just appended to its sources array: it starts from nothing, so it gets a full scan. */
    public addSource(slot: number): void {
        this.states[slot] = newSourceState();
        if (this.store.syncStarted) {
            void this.startSourceSyncLoops(slot);
        }
    }

    /** The slot stays in the store's arrays forever (running loops hold slot numbers); it just goes dead - loops stop, and its index entries drop (other sources' scans re-find any copy that's still reachable through the new config). */
    public async removeSource(slot: number): Promise<void> {
        let state = this.states[slot];
        let source = this.store.sources[slot].source;
        state.dead = true;
        state.stopped.stop = true;
        state.scanComplete = true;
        state.initialScan.resolve(undefined);
        let sourcesListIndex = this.store.slotSourcesListIndex(slot);
        // The same URL can be another live slot (one entry per valid window) - the endpoint is still configured, so its entries stay
        if (sourcesListIndex !== undefined && this.store.slotForSourcesListIndex(sourcesListIndex) === undefined) {
            let dropped = 0;
            for (let [key, entry] of this.store.indexEntries()) {
                if (entry.sourcesListIndex !== sourcesListIndex) continue;
                // Forgotten, not deleted: the files still exist wherever that source put them, we just no longer have a way to reach them
                this.store.purgeIndexEntry(key);
                dropped++;
            }
            console.log(`Removed sync source ${source.getDebugName()} (store ${this.store.folder}): its scans are stopped and ${dropped} index entries it held were dropped`);
            return;
        }
        console.log(`Removed sync source ${source.getDebugName()} (store ${this.store.folder}): its scans are stopped (its URL is still served by another slot, so its index entries stay)`);
    }

    /** Whether a slot is still configured. Dead slots are never scanned, written, or read. */
    public isLive(slot: number): boolean {
        return !!this.store.sources[slot] && !this.states[slot]?.dead;
    }

    public getActivities(): SyncActivity[] {
        return [...this.activities];
    }

    /** A key was just served, so it goes to the back of the eviction queue. */
    public noteAccess(key: string): void {
        this.lastAccess.set(key, Date.now());
    }

    // Whether the index still holds exactly the entry a pass picked up earlier. Index rows are read out of the database per lookup, so this compares the row, not the object - a write landing mid-pass changes at least one of these three.
    private entryUnchanged(key: string, entry: IndexEntry): boolean {
        let current = this.store.getIndexEntry(key);
        if (!current) return false;
        return current.writeTime === entry.writeTime && current.size === entry.size && current.sourcesListIndex === entry.sourcesListIndex;
    }

    public getStatus(): ArchivesSyncStatus {
        return {
            allScansComplete: this.states.every(x => x.scanComplete),
            indexSize: this.store.indexSize(),
            sources: this.store.sources.map((x, i) => ({
                debugName: x.source.getDebugName(),
                validWindows: x.validWindows,
                route: x.route,
                noFullSync: x.noFullSync,
                supportsChangesAfter: this.states[i].supportsChangesAfter,
                initialScanComplete: this.states[i].scanComplete,
                scannedCount: this.states[i].scannedCount,
            })).filter((x, i) => this.isLive(i)),
        };
    }

    /** Listings come straight from the index, so they must wait for our own base source's initial scan (which might lag minutes) before they are trustworthy. The base (local disk) is implicitly required - remote sources are not, they come and go. */
    public async waitForRequiredScans(): Promise<void> {
        await this.states[0].initialScan.promise;
    }

    /** Rescans our own disk's metadata into the index - used around valid window handoffs, where another process wrote files to the shared folder that our index hasn't seen. */
    public async rescanBase(): Promise<void> {
        await this.syncSource(0)();
    }

    /** One synchronization round of a source: the PULL direction always (its listing, applied to our index), and with "push" the push direction too (what our index says the source is missing, written to it). Push is an argument rather than a separate call because it cannot run without the pull's listing - the index alone cannot say what the source already holds. Listings unblock (initialScan) between the halves, so they never wait behind a push. Only one round per SOURCE runs at a time (cache keys the serializer by source index). */
    private syncSource = cache((sourceIndex: number) => runInSerial(async (push?: "push"): Promise<void> => {
        let listing = await this.pullSource(sourceIndex);
        let state = this.states[sourceIndex];
        state.scanComplete = true;
        state.initialScan.resolve(undefined);
        if (push && !this.store.stopped.stop && !state.stopped.stop) {
            await this.pushSource(sourceIndex, listing);
        }
    }));

    /** A boundary scan of the node that owned (part of) our route in the valid window before ours, when that node is different storage (a disk rescan can't see its writes): just its changes since the boundary neighborhood, with matching values pulled onto our own disk. */
    public async boundaryScanRemote(source: IArchives, config: { since: number; route?: [number, number] }): Promise<void> {
        let scanStart = Date.now();
        logSyncEvent({ event: "boundaryScanStart", store: this.store.folder, source: source.getDebugName(), since: config.since, route: config.route || FULL_ROUTE });
        let changes = await source.getChangesAfter2({ time: config.since, routes: config.route && [config.route] || undefined, internal: true });
        let tally = newScanTally();
        for (let file of changes) {
            if (file.path === ROUTING_FILE) {
                tally.filtered++;
                continue;
            }
            let currentTime = this.store.currentWriteTime(file.path);
            if (file.createTime <= currentTime) {
                tally.unchanged++;
                continue;
            }
            if (file.size === 0) {
                // Size 0 in a listing IS a deletion (an empty file is a missing file), so it is taken as one
                this.store.setIndexDeleted(file.path, file.createTime);
                tally.tombstone++;
                continue;
            }
            let copied = await copyArchiveFile({ from: source, to: this.store.sources[0].source, path: file.path, preserveWriteTime: true, forceSetImmutable: true, noChecks: true, internal: true });
            if (!copied) {
                // Undefined is two cases (see copyArchiveFile): our own disk already holding something newer is the boundary scan working as intended (our writes since the boundary outrank the neighbor's), only a genuinely unreadable file is worth a warning
                let local = await this.store.sources[0].source.getInfo(file.path);
                if (local && local.writeTime > file.createTime) {
                    logSyncEvent({ event: "boundaryScanLocalNewer", store: this.store.folder, source: source.getDebugName(), path: file.path, theirWriteTime: formatDateTimeDetailed(file.createTime), theirSize: file.size, localWriteTime: formatDateTimeDetailed(local.writeTime), localSize: local.size });
                    this.store.setIndexEntry(file.path, { writeTime: local.writeTime, size: local.size, sourcesListIndex: this.store.sourcesListIndexOfSlot(0) });
                    tally.unchanged++;
                    continue;
                }
                console.warn(`Boundary scan could not copy ${file.path} from ${source.getDebugName()} (store ${this.store.folder}): its change feed listed it (${file.size} bytes, writeTime ${formatDateTimeDetailed(file.createTime)}) but the read found nothing`);
                continue;
            }
            this.store.noteSyncTransfer("sync get", file.path, copied.size);
            if (copied.size === 0) {
                this.store.setIndexDeleted(file.path, copied.writeTime);
                tally.tombstone++;
                continue;
            }
            this.store.setIndexEntry(file.path, { writeTime: copied.writeTime, size: copied.size, sourcesListIndex: this.store.sourcesListIndexOfSlot(0) });
            if (currentTime) {
                tally.updated++;
            } else {
                tally.new++;
            }
        }
        logSyncEvent({ event: "boundaryScanFinish", store: this.store.folder, source: source.getDebugName(), durationMs: Date.now() - scanStart, since: config.since, changes: changes.length, newPaths: tally.new, updated: tally.updated, tombstones: tally.tombstone, unchanged: tally.unchanged });
    }

    // ── per-source loops ──

    // Slot 0 is exempt: our own disk answers for every window this store EVER held, and scanning it is what keeps the index honest about them. Read live each call - updateSources moves the windows on running slots, so a source goes stale (or comes back) while its loops run.
    private windowsAllowScanning(sourceIndex: number): boolean {
        if (sourceIndex === 0) return true;
        return this.store.sources[sourceIndex].validWindows.some(w => w[1] > Date.now() - PAST_READ_DURATION);
    }

    private async startSourceSyncLoops(sourceIndex: number): Promise<void> {
        await this.store.registerSlot(sourceIndex);
        let sourceObj = this.store.sources[sourceIndex];
        let source = sourceObj.source;
        let state = this.states[sourceIndex];
        // If a slot ever gets TWO of these, its loops are doubled - every poll and full sync runs twice
        logSyncEvent({ event: "sourceSyncStart", store: this.store.folder, source: source.getDebugName(), sourceIndex, url: this.store.sources[sourceIndex].url, intermediate: this.store.sources[sourceIndex].intermediate });
        // Read live for every pass, not captured - the store's source list can change while loops run
        let noFullSync = () => this.store.sources[sourceIndex].noFullSync;
        // An intermediate is a deploy switchover's temporary alternate PORT onto a source we already have: the same bucket, reachable another way for a few minutes. Scanning it would list exactly what scanning that source lists, against a port that is about to disappear - so it is never scanned, and the source it was split out of covers it for as long as it exists and after it is gone.
        if (this.store.sources[sourceIndex].intermediate) {
            state.scanComplete = true;
            state.initialScan.resolve(undefined);
            return;
        }
        // Checked per tick, never decided once: the windows move on running slots (see updateSources), so a source goes stale mid-life and can come back if a config extends them. Logged only on each transition into staleness.
        let loggedStale = false;
        let skipStale = () => {
            if (this.windowsAllowScanning(sourceIndex)) {
                loggedStale = false;
                return false;
            }
            state.scanComplete = true;
            state.initialScan.resolve(undefined);
            if (!loggedStale) {
                loggedStale = true;
                logSyncEvent({ event: "scanSkippedStaleWindows", store: this.store.folder, source: source.getDebugName(), validWindows: this.store.sources[sourceIndex].validWindows.map(w => [formatDateTimeDetailed(w[0]), formatDateTimeDetailed(w[1])]), pastReadDurationMs: PAST_READ_DURATION });
            }
            return true;
        };
        // An already-stale source skips getConfig entirely: its endpoint is often long gone, and retrying that every 30s forever is noise about a source we would not scan anyway (if its windows are later extended, the full-round poll below picks it up - just without change polling until a restart)
        while (!skipStale() && !this.store.stopped.stop && !state.stopped.stop) {
            try {
                let config = await source.getConfig();
                state.supportsChangesAfter = !!config.supportsChangesAfter;
                break;
            } catch (e) {
                logSyncEvent({ event: "initialScanFailed", store: this.store.folder, source: source.getDebugName(), retryInMs: SCAN_RETRY_DELAY, error: String((e as Error).stack ?? e).slice(0, 2000) });
                await delay(SCAN_RETRY_DELAY);
            }
        }
        if (this.store.stopped.stop || state.stopped.stop) return;
        // Hourly for our own disk (no sourceConfig - a cheap local walk, and how a sibling process's writes into the shared folder are found) and for remote peers (index-backed, cheap listings); the slow interval is only for sources where a full listing is genuinely expensive (backblaze)
        let pollInterval = (!sourceObj.sourceConfig || sourceObj.sourceConfig.type === "remote") && FULL_RESCAN_INTERVAL || FULL_RESCAN_NON_REMOTE_INTERVAL;
        // Both loops below run one at a time: a change-poll tick landing mid full round would otherwise start a second copy pass over the same pending list, downloading everything twice
        let serial = runInSerial(async (fnc: () => Promise<void>) => await fnc());
        await runInfinitePollCallAtStart(pollInterval, () => serial(async () => {
            if (skipStale()) return;
            while (!this.store.stopped.stop && !state.stopped.stop) {
                try {
                    await this.syncSource(sourceIndex)("push");
                    if (!noFullSync()) await this.copySourceFiles(sourceIndex)();
                } catch (e) {
                    logSyncEvent({ event: "scanFailed", store: this.store.folder, source: source.getDebugName(), retryInMs: SCAN_RETRY_DELAY, error: String((e as Error).stack ?? e).slice(0, 2000) });
                    await delay(SCAN_RETRY_DELAY);
                    continue;
                }
                state.scanComplete = true;
                state.initialScan.resolve(undefined);
                break;
            }
        }), state.stopped);
        if (state.supportsChangesAfter) {
            runInfinitePoll(CHANGES_POLL_INTERVAL, () => serial(async () => {
                if (skipStale()) return;
                // A scan that has not succeeded yet is retried HERE, before anything else - polling changes and copying against a never-scanned source would run on arbitrarily stale information
                if (!state.scanSucceeded) {
                    await this.syncSource(sourceIndex)("push");
                }
                await this.pollChanges(sourceIndex);
                if (!noFullSync()) await this.copySourceFiles(sourceIndex)();
            }), state.stopped);
        }
    }

    // The PULL direction: a full metadata scan (size, writeTime, path) of one source, applied to our index. Returns the source's listing (path -> write time), which pushSource uses for the opposite direction.
    private async pullSource(sourceIndex: number): Promise<Map<string, number>> {
        let { source, route } = this.store.sources[sourceIndex];
        let state = this.states[sourceIndex];
        let scanStart = Date.now();
        let activity: SyncActivity = { type: "metadataScan", sourceDebugName: source.getDebugName(), startTime: scanStart };
        this.activities.add(activity);
        logSyncEvent({ event: "scanStart", store: this.store.folder, source: source.getDebugName() });
        let progressTimer = setInterval(() => {
            console.log(`Metadata scan of ${source.getDebugName()} still running (${Math.round((Date.now() - scanStart) / 1000)}s, store ${this.store.folder})`);
        }, SYNC_PROGRESS_LOG_INTERVAL);
        (progressTimer as { unref?: () => void }).unref?.();
        // The listing request deliberately takes no time or route filters: our slowest sources (backblaze) support neither, so filtering would happen after the full fetch anyway - little benefit, more room for desynchronization. And if a full listing ever becomes too big to send over the network, it is also too big for the receiving process to hold in memory - the fix is more routing shards (each storing and sending less), not filtering.
        let files: ArchiveFileInfo[];
        try {
            let attempts = 0;
            while (true) {
                files = await source.findInfo("", { internal: true });
                if (this.store.stopped.stop || state.stopped.stop) break;
                // What we believe the source has: whichever is larger of its previous listing and the index entries naming it as holder. Files do not just vanish - a listing far below this means the other end is briefly broken, and believing it would purge everything it held.
                let held = 0;
                let scannedSourcesListIndex = this.store.sourcesListIndexOfSlot(sourceIndex);
                for (let [, entry] of this.store.indexEntries()) {
                    if (entry.sourcesListIndex === scannedSourcesListIndex) held++;
                }
                let expected = Math.max(state.scannedCount, held);
                if (!(expected > 0 && files.length < expected / 2)) break;
                if (attempts >= SUSPICIOUS_SCAN_RETRIES) {
                    console.warn(`Metadata scan of ${source.getDebugName()} (store ${this.store.folder}) STILL lists ${files.length} files where ~${expected} were expected, after ${attempts} retries - accepting the listing as the truth`);
                    break;
                }
                attempts++;
                console.warn(`Metadata scan of ${source.getDebugName()} (store ${this.store.folder}) listed ${files.length} files, but ~${expected} were expected (previous listing ${state.scannedCount}, index entries it holds ${held}) - the other end is probably briefly broken; asking again in ${SUSPICIOUS_SCAN_RETRY_DELAY / 1000}s (retry ${attempts} of ${SUSPICIOUS_SCAN_RETRIES})`);
                await delay(SUSPICIOUS_SCAN_RETRY_DELAY);
            }
        } finally {
            clearInterval(progressTimer);
            this.activities.delete(activity);
        }
        // The source may have been removed while the listing was in flight; its results are dead
        if (state.stopped.stop) return new Map();
        let indexSizeBefore = this.store.indexSize();
        let seen = new Map<string, number>();
        let tally = newScanTally();
        let newPaths = 0;
        for (let file of files) {
            seen.set(file.path, file.createTime);
            if (!this.store.getIndexEntry(file.path)) {
                newPaths++;
            }
            tally[this.updateScanIndex(sourceIndex, file)]++;
        }
        state.scannedCount = files.length;
        // Entries this source was the holder of, but that its listing did not mention: our own disk takes over as holder when it has a copy, and only with no local copy either is the entry forgotten - we were wrong about where the file is, which is not the same as it having been deleted. Entries changed after the scan started are kept: the listing may simply predate them. Tombstones are not walked here at all, because they are not files a listing could vouch for.
        let removedFromIndex = 0;
        let repointedToLocal = 0;
        let missingOnSource = 0;
        let scannedSourcesListIndex = this.store.sourcesListIndexOfSlot(sourceIndex);
        for (let [key, entry] of this.store.indexEntries()) {
            if (seen.has(key)) continue;
            if (entry.sourcesListIndex === scannedSourcesListIndex && entry.changedAt < scanStart) {
                if (sourceIndex !== 0) {
                    let local = await this.store.sources[0].source.getInfo(key);
                    if (local) {
                        this.store.setIndexEntry(key, { writeTime: entry.writeTime, size: local.size, sourcesListIndex: this.store.sourcesListIndexOfSlot(0) });
                        repointedToLocal++;
                        continue;
                    }
                }
                this.store.purgeIndexEntry(key);
                removedFromIndex++;
                continue;
            }
            // Counted only when the source SHOULD hold the entry (its route matches) - these are what the reconcile pass pushes to it (which also ignores the valid window: synchronization moves existing values, the window only routes fresh writes)
            if (key === ROUTING_FILE) continue;
            if (!routeContains(route, getRoute(key))) continue;
            missingOnSource++;
        }
        logSyncEvent({ event: "scanFinish", store: this.store.folder, source: source.getDebugName(), durationMs: Date.now() - scanStart, listed: files.length, indexedBefore: indexSizeBefore, newPaths: tally.new, updated: tally.updated, tombstones: tally.tombstone, unchanged: tally.unchanged, outsideRoute: tally.filtered, missingOnSource, repointedToLocal, removedFromIndex });
        state.changesAfterTime = Math.max(state.changesAfterTime, scanStart - CHANGES_POLL_OVERLAP);
        state.scanSucceeded = true;
        return seen;
    }

    // The push direction of synchronization: everything we know that the source is missing (or holds an older copy of) is written to it — including deletions, as tombstone writes. This is what heals a source whose background writes failed (e.g. it was down): the next scan sees what's missing and re-sends it. A failing file is skipped, not fatal (immutable targets are handled by forceSetImmutable, and one unreadable value must not stop the rest of the pass) - only a run of consecutive failures (the source itself is down) aborts until the next scan cycle.
    private async pushSource(sourceIndex: number, listing: Map<string, number>): Promise<void> {
        let { source, validWindows, route } = this.store.sources[sourceIndex];
        let state = this.states[sourceIndex];
        let acceptsWrites = windowsAcceptWrites(validWindows);
        let targetSourcesListIndex = this.store.sourcesListIndexOfSlot(sourceIndex);
        let pushed = 0;
        let failed = 0;
        let consecutiveFailures = 0;
        let errors: string[] = [];
        let aborted = false;
        // Files first, then the deletions - two walks now that they are two maps, and the deletions one is the short one
        let pushable: { key: string; writeTime: number; entry?: IndexEntry }[] = [];
        for (let [key, entry] of this.store.indexEntries()) {
            if (entry.sourcesListIndex === targetSourcesListIndex) continue;
            pushable.push({ key, writeTime: entry.writeTime, entry });
        }
        for (let [key, tombstone] of this.store.deletedEntries()) {
            pushable.push({ key, writeTime: tombstone.writeTime });
        }
        for (let { key, writeTime, entry } of pushable) {
            if (this.store.stopped.stop || state.stopped.stop) return;
            // The routing file is not reconciled: it propagates by being asked for, on its own schedule (see pollRoutingConfig)
            if (key === ROUTING_FILE) continue;
            if (!acceptsWrites) continue;
            if (!routeContains(route, getRoute(key))) continue;
            let theirTime = listing.get(key);
            if (theirTime !== undefined && theirTime >= writeTime) continue;
            try {
                if (!entry) {
                    // A deletion only needs pushing while the source still holds an older copy. It travels as del (never as an empty set - set rejects empty buffers), with the ORIGINAL deletion time so ordering survives.
                    if (theirTime === undefined) continue;
                    await source.del(key, { lastModified: writeTime, noChecks: true, internal: true });
                    this.store.noteSyncTransfer("sync set", key, 0);
                    pushed++;
                    consecutiveFailures = 0;
                    continue;
                }
                let holder = await this.store.getEntryHolder(entry);
                if (!holder) continue;
                let copied = await copyArchiveFile({ from: holder, to: source, path: key, preserveWriteTime: true, forceSetImmutable: true, noChecks: true, internal: true });
                if (!copied) {
                    // Undefined is two cases (see copyArchiveFile). The source having a NEWER file than our index (the listing we pushed from was stale) is adopted exactly the way the pull direction adopts a listing entry - and pushing our stale copy stops. Otherwise the HOLDER could not produce the file, which the next round's pull re-resolves; either way, silence here was the bug.
                    let theirs = await source.getInfo(key);
                    if (theirs && theirs.writeTime > writeTime) {
                        this.store.setIndexEntry(key, { writeTime: theirs.writeTime, size: theirs.size, sourcesListIndex: targetSourcesListIndex });
                        logSyncEvent({ event: "pushFoundNewerOnSource", store: this.store.folder, source: source.getDebugName(), path: key, ourWriteTime: formatDateTimeDetailed(writeTime), theirWriteTime: formatDateTimeDetailed(theirs.writeTime), ourSize: entry.size, theirSize: theirs.size });
                        continue;
                    }
                    logSyncEvent({ event: "pushCopyUnavailable", store: this.store.folder, source: source.getDebugName(), path: key, holder: holder.getDebugName(), expectedSize: entry.size, expectedWriteTime: formatDateTimeDetailed(writeTime), sourceHas: theirs && `${theirs.size} bytes at ${formatDateTimeDetailed(theirs.writeTime)}` || "nothing" });
                    continue;
                }
                this.store.noteSyncTransfer("sync set", key, copied.size);
                pushed++;
                consecutiveFailures = 0;
            } catch (e) {
                failed++;
                consecutiveFailures++;
                if (errors.length < SYNC_ERROR_LOG_LIMIT) {
                    errors.push(`${key}: ${(e as Error).stack ?? e}`);
                }
                if (consecutiveFailures >= SYNC_MAX_CONSECUTIVE_FAILURES) {
                    aborted = true;
                    break;
                }
                // A pause per failure, so a down network takes minutes to burn through the consecutive-failure allowance instead of an instant
                await delay(SYNC_FAILURE_DELAY);
            }
        }
        if (failed) {
            console.error(`Reconciling sync source ${source.getDebugName()} (store ${this.store.folder}): pushed ${pushed} files, ${failed} failed${aborted && ` before aborting the pass (${consecutiveFailures} consecutive failures - the source looks down; the next scan cycle retries)` || ""}. First errors: ${errors.join(" | ")}`);
        }
        logSyncEvent({ event: "reconcileFinish", store: this.store.folder, source: source.getDebugName(), pushed, failed, aborted });
    }

    private updateScanIndex(sourceIndex: number, file: ArchiveFileInfo): ScanOutcome {
        // An in-flight scan can outlive its source's removal; its results are dead
        if (!this.isLive(sourceIndex)) return "filtered";
        if (file.path === ROUTING_FILE) {
            // The routing config is NEVER pulled from other sources - it only ever arrives as an explicit, version-validated write, and is only ever read off our own disk. Route and valid-window filters can't possibly apply to it either: it is the file DEFINING them, so filtering it would mean certain sources could never have their routing config updated, ever.
            if (sourceIndex !== 0) return "filtered";
        } else {
            // The valid window is deliberately NOT applied here: it decides where WRITES route, but a scan is us asking a source what it already holds - existing values synchronize regardless of the window (the same reasoning that lets synchronization ignore the immutable flag). Only the route filters: a partially-overlapping shard's listing legitimately includes keys that aren't ours.
            let { route } = this.store.sources[sourceIndex];
            if (!routeContains(route, getRoute(file.path))) return "filtered";
        }
        let existing = this.store.getIndexEntry(file.path);
        // The highest write time wins across all sources, and a tie keeps what we have - otherwise every rescan of an unchanged file would re-record it, moving its holder and writing a log record for nothing. currentWriteTime counts deletions, so a listing that still shows a file we know was deleted does not resurrect it.
        if (file.createTime <= this.store.currentWriteTime(file.path)) return "unchanged";
        // Size 0 in a listing IS a deletion - an empty file is a missing file - so that is what it is taken as
        if (file.size === 0) {
            this.store.setIndexDeleted(file.path, file.createTime);
            return "tombstone";
        }
        this.store.setIndexEntry(file.path, { writeTime: file.createTime, size: file.size, sourcesListIndex: this.store.sourcesListIndexOfSlot(sourceIndex) });
        if (existing) return "updated";
        return "new";
    }

    private async pollChanges(sourceIndex: number): Promise<void> {
        let { source, route } = this.store.sources[sourceIndex];
        let state = this.states[sourceIndex];
        let pollStart = Date.now();
        let changes = await source.getChangesAfter2({ time: state.changesAfterTime, routes: route && [route] || undefined, internal: true });
        let tally = newScanTally();
        for (let file of changes) {
            tally[this.updateScanIndex(sourceIndex, file)]++;
        }
        // Polls run constantly, so only the ones that actually changed the index get an entry
        if (tally.new || tally.updated || tally.tombstone) {
            logSyncEvent({ event: "changesPoll", store: this.store.folder, source: source.getDebugName(), changes: changes.length, newPaths: tally.new, updated: tally.updated, tombstones: tally.tombstone, unchanged: tally.unchanged });
        }
        state.scannedCount += changes.length;
        state.changesAfterTime = pollStart - CHANGES_POLL_OVERLAP;
    }

    // Downloads the files a source currently holds onto our own base source (the local disk), preserving their modified times — so a newer local write always wins. Skipped for noFullSync sources (fronting a large database without copying it); reads still down-cache lazily. Only one pass per SOURCE runs at a time (cache keys the serializer by source index) - two passes over the same pending list would download everything twice.
    private copySourceFiles = cache((sourceIndex: number) => runInSerial(async (): Promise<void> => {
        if (sourceIndex === 0) return;
        let { source } = this.store.sources[sourceIndex];
        let state = this.states[sourceIndex];
        let pending: { key: string; entry: IndexEntry }[] = [];
        let totalBytes = 0;
        let copiedSourcesListIndex = this.store.sourcesListIndexOfSlot(sourceIndex);
        for (let [key, entry] of this.store.indexEntries()) {
            if (entry.sourcesListIndex !== copiedSourcesListIndex) continue;
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
        this.activities.add(activity);
        logSyncEvent({ event: "deltaSyncStart", store: this.store.folder, source: source.getDebugName(), diffBased: state.supportsChangesAfter, files: pending.length, bytes: totalBytes });
        let progressLogged = false;
        let logProgress = () => {
            progressLogged = true;
            console.log(magenta(`Delta sync from ${source.getDebugName()} (store ${this.store.folder}): ${activity.doneFiles}/${pending.length} files (${((activity.doneFiles || 0) / pending.length * 100).toFixed(1)}%), ${formatNumber(activity.doneBytes || 0)}B/${formatNumber(totalBytes)}B (${(totalBytes && (activity.doneBytes || 0) / totalBytes * 100 || 100).toFixed(1)}%)`));
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
                etaText = `${formatTime(remainingMs)} remaining, completing around ${formatDateTimeDetailed(Date.now() + remainingMs)}`;
            }
            console.warn(`Delta sync from ${source.getDebugName()} (store ${this.store.folder}) has been running for ${formatTime(elapsed)}: ${doneFiles}/${pending.length} files (${(doneFiles / pending.length * 100).toFixed(1)}%), ${formatNumber(doneBytes)}B/${formatNumber(totalBytes)}B (${(totalBytes && doneBytes / totalBytes * 100 || 100).toFixed(1)}%), ${formatNumber(bytesPerSecond)}B/s. Estimated ${etaText}.`);
        }, FULL_SYNC_SLOW_ERROR_INTERVAL);
        (slowErrorTimer as { unref?: () => void }).unref?.();
        let failed = 0;
        let copiedFiles = 0;
        let copiedBytes = 0;
        let missingOnSource = 0;
        let aborted = false;
        // The source cannot give us the file (its read had nothing, or it errored). Retrying the same entry forever is not an answer: if our own disk holds a copy, IT becomes the holder; with no local copy either, the entry is purged - forgotten, not deleted, exactly like a read that comes up empty everywhere - and the next full pull re-finds it if it exists anywhere.
        let resolveUnavailable = async (event: string, key: string, entry: IndexEntry, extra: { [key: string]: unknown }) => {
            let base = { event, store: this.store.folder, source: source.getDebugName(), path: key, expectedSize: entry.size, expectedWriteTime: entry.writeTime, ...extra };
            let local = await this.store.sources[0].source.getInfo(key);
            if (local) {
                // The local copy can be NEWER than the entry (which is exactly why copyArchiveFile refuses to overwrite it - see its destination check), so the repoint keeps the newer of the two times rather than rolling the index back
                this.store.setIndexEntry(key, { writeTime: Math.max(entry.writeTime, local.writeTime), size: local.size, sourcesListIndex: this.store.sourcesListIndexOfSlot(0) });
                logSyncEvent({ ...base, resolution: "repointed to our local copy", localSize: local.size, localWriteTime: formatDateTimeDetailed(local.writeTime) });
                return;
            }
            if (this.store.currentWriteTime(key) <= entry.writeTime) {
                this.store.purgeIndexEntry(key);
                logSyncEvent({ ...base, resolution: "purged - neither the source nor our disk has it, so it does not exist" });
                return;
            }
            // A newer write landed while we were checking - the entry is no longer the one we found unavailable, so it is left alone
            logSyncEvent({ ...base, resolution: "kept - a newer write appeared while checking", currentWriteTime: this.store.currentWriteTime(key) });
        };
        try {
            let nextIndex = 0;
            let consecutiveFailures = 0;
            let copyWorker = async () => {
                while (!aborted && !this.store.stopped.stop && !state.stopped.stop) {
                    let index = nextIndex++;
                    if (index >= pending.length) return;
                    let { key, entry } = pending[index];
                    try {
                        let copied = await copyArchiveFile({ from: source, to: this.store.sources[0].source, path: key, preserveWriteTime: true, forceSetImmutable: true, noChecks: true, internal: true });
                        if (copied) {
                            copiedFiles++;
                            copiedBytes += copied.size;
                            this.store.noteSyncTransfer("sync get", key, copied.size);
                            // The copy carries the source's write time, and the index commits it under the normal ordering rule (>= the current time wins) - it refusing means a NEWER write landed while we copied, which must be said, not swallowed
                            if (!this.store.setIndexEntry(key, { writeTime: copied.writeTime, size: copied.size, sourcesListIndex: this.store.sourcesListIndexOfSlot(0) })) {
                                logSyncEvent({ event: "deltaSyncCommitSuperseded", store: this.store.folder, source: source.getDebugName(), path: key, copiedWriteTime: copied.writeTime, currentWriteTime: this.store.currentWriteTime(key) });
                            }
                        } else {
                            missingOnSource++;
                            await resolveUnavailable("deltaSyncMissingOnSource", key, entry, {});
                        }
                        consecutiveFailures = 0;
                    } catch (e) {
                        // A failing file resolves exactly like a missing one (the source cannot give it to us either way), so it never wedges the pass on retries forever - and the next full pull re-finds it if the source recovers
                        failed++;
                        consecutiveFailures++;
                        try {
                            await resolveUnavailable("deltaSyncCopyFailed", key, entry, { error: String((e as Error).stack ?? e).slice(0, 2000) });
                        } catch (resolveError) {
                            logSyncEvent({ event: "deltaSyncCopyFailed", store: this.store.folder, source: source.getDebugName(), path: key, error: String((e as Error).stack ?? e).slice(0, 2000), resolveError: String((resolveError as Error).stack ?? resolveError).slice(0, 2000) });
                        }
                        if (consecutiveFailures >= SYNC_MAX_CONSECUTIVE_FAILURES) {
                            aborted = true;
                            return;
                        }
                        // A pause per failure, so a down network takes minutes to burn through the consecutive-failure allowance instead of an instant
                        await delay(SYNC_FAILURE_DELAY);
                    }
                    activity.doneFiles = (activity.doneFiles || 0) + 1;
                    activity.doneBytes = (activity.doneBytes || 0) + entry.size;
                }
            };
            let workers: Promise<void>[] = [];
            for (let i = 0; i < Math.min(FULL_SYNC_PARALLEL, pending.length); i++) {
                workers.push(copyWorker());
            }
            await Promise.all(workers);
        } finally {
            clearInterval(progressTimer);
            clearInterval(slowErrorTimer);
            this.activities.delete(activity);
            // A sync slow enough to have logged progress also logs its completion
            if (progressLogged) {
                logProgress();
            }
            logSyncEvent({ event: "deltaSyncFinish", store: this.store.folder, source: source.getDebugName(), diffBased: state.supportsChangesAfter, durationMs: Date.now() - activity.startTime, totalFiles: pending.length, totalBytes, processedFiles: activity.doneFiles, copiedFiles, copiedBytes, missingOnSource, failed, aborted });
        }
    }));

    // ── maintenance ──

    // readerDiskLimit: the disk is only a bounded read cache, so once it exceeds the limit, the least recently used files are deleted from it - but ONLY when another source verifiably holds a same-or-newer copy (the only copy of a file is never deleted), and the index entry repoints to that source so reads keep working (re-caching on the next read).
    private async enforceDiskLimit(): Promise<void> {
        let limit = this.store.readerDiskLimit;
        if (!limit || this.evicting) return;
        let totals = this.store.indexTotals();
        // Counted down as we evict, rather than re-read per file: a pass only ever removes bytes from the disk, and anything written during it is picked up by the next pass
        let diskBytes = totals.slots[0].byteCount;
        if (diskBytes <= limit) return;
        this.evicting = true;
        let evictedFiles = 0;
        let evictedBytes = 0;
        try {
            let baseSourcesListIndex = this.store.sourcesListIndexOfSlot(0);
            let candidates: { key: string; entry: IndexEntry }[] = [];
            for (let [key, entry] of this.store.indexEntries()) {
                if (entry.sourcesListIndex !== baseSourcesListIndex || key === ROUTING_FILE) continue;
                candidates.push({ key, entry });
            }
            // Least recently READ first; a key nobody has read since we started falls back to when we last changed it
            sort(candidates, x => this.lastAccess.get(x.key) || x.entry.changedAt);
            for (let { key, entry } of candidates) {
                if (this.store.stopped.stop) return;
                if (diskBytes <= limit) break;
                if (!this.entryUnchanged(key, entry)) continue;
                let holder: number | undefined;
                for (let i = 1; i < this.store.sources.length; i++) {
                    if (!this.isLive(i)) continue;
                    try {
                        let info = await this.store.sources[i].source.getInfo(key);
                        if (info && info.writeTime >= entry.writeTime) {
                            holder = i;
                            break;
                        }
                    } catch {
                        // A down source just can't vouch for this file right now
                    }
                }
                if (holder === undefined) continue;
                await this.store.sources[0].source.del(key);
                this.store.setIndexEntry(key, { writeTime: entry.writeTime, size: entry.size, sourcesListIndex: this.store.sourcesListIndexOfSlot(holder) });
                evictedFiles++;
                evictedBytes += entry.size;
                diskBytes -= entry.size;
            }
        } finally {
            this.evicting = false;
            if (evictedFiles) {
                console.log(`Disk cache over readerDiskLimit (store ${this.store.folder}): evicted ${evictedFiles} least-recently-used files (${formatNumber(evictedBytes)}B), now at ${formatNumber(diskBytes)}B/${formatNumber(limit)}B`);
            }
        }
    }

    // Tombstones only need to exist long enough for every store to learn of the deletion; expired ones are forgotten entirely. A walk of the tombstones alone, which is why it can run often and cost nothing. The physical empty file is removed only on backblaze sources: remote stores expire their own tombstones (a del there would just mint a fresh one), and our own disk never stored anything for it.
    private async cleanupTombstones(): Promise<void> {
        let cutoff = Date.now() - TOMBSTONE_EXPIRY;
        for (let [key, tombstone] of this.store.deletedEntries()) {
            if (this.store.stopped.stop) return;
            if (tombstone.writeTime > cutoff) continue;
            // A MARKED deletion never expires by time - its bytes are still on disk, and purging the tombstone would let the next disk scan resurrect them as live. Retention expires it by SIZE (enforceHistoryLimit); only once the bytes are gone does the plain tombstone age out here.
            if (this.store.getMarkedEntry(key)) continue;
            this.store.purgeIndexEntry(key);
            for (let i = 0; i < this.store.sources.length; i++) {
                if (!this.isLive(i)) continue;
                let sourceEntry = this.store.sources[i];
                if (!windowsAcceptWrites(sourceEntry.validWindows)) continue;
                let source = sourceEntry.source;
                if (!(source instanceof ArchivesBackblaze)) continue;
                void source.del(key).catch((e: Error) => {
                    console.error(`Removing expired tombstone ${key} from ${source.getDebugName()} failed: ${e.stack ?? e}`);
                });
            }
        }
    }

    // Deletion history retention: marked files keep their bytes on our disk until the history outgrows max(HISTORY_MIN_BYTES, live bytes * history factor); then the OLDEST deletions lose their bytes and become plain tombstones, which age out normally (cleanupTombstones)
    private async enforceHistoryLimit(): Promise<void> {
        let allowed = Math.max(HISTORY_MIN_BYTES, this.store.indexTotals().byteCount * await getHistoryFactor());
        let marked: { key: string; size: number; deleteTime: number }[] = [];
        let totalBytes = 0;
        for (let [key, entry] of this.store.markedEntries()) {
            marked.push({ key, size: entry.size, deleteTime: entry.deleteTime });
            totalBytes += entry.size;
        }
        if (totalBytes <= allowed) return;
        let startedWithBytes = totalBytes;
        sort(marked, x => x.deleteTime);
        let dropped = 0;
        let droppedBytes = 0;
        for (let { key, size } of marked) {
            if (this.store.stopped.stop) return;
            if (totalBytes <= allowed) break;
            await this.store.dropMarkedHistory(key);
            totalBytes -= size;
            dropped++;
            droppedBytes += size;
        }
        console.log(`Deletion history of store ${this.store.folder} outgrew its budget (${formatNumber(startedWithBytes)}B kept vs ${formatNumber(allowed)}B allowed): dropped the ${dropped} oldest marked files (${formatNumber(droppedBytes)}B); their tombstones remain until they age out`);
    }
}
