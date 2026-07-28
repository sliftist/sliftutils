import path from "path";
import { lazy } from "socket-function/src/caching";
import { timeInMinute, sort } from "socket-function/src/misc";
import { formatDateTimeDetailed } from "socket-function/src/formatting/format";
import {
    IArchives, ArchiveFileInfo, ArchivesSource, ArchivesSyncStatus, ChangesAfterConfig, FindConfig, HostedConfig, RemoteConfig, SourceConfig, assertValidLastModified,
    windowsAcceptWrites, SyncActivity, FULL_ROUTE, FULL_VALID_WINDOW, STORAGE_WRONG_VALID_WINDOW, STORAGE_WRONG_ROUTE, STORAGE_NOT_CONFIGURED,
} from "../IArchives";
import { ArchivesDisk, applyFindInfoShape } from "../ArchivesDisk";
import { ROUTING_FILE, getRoute, routeContains, routeIntersection, parseRoutingData, serializeRemoteConfig, assertValidRemoteConfig, getConfigVersion, sourceIdentity, sourcePersistentUrl } from "./remoteConfig";
import { selectEntryAt } from "./storePlan";
import { sourceWriteDelay } from "./ArchivesDelayed";
import { TransactionFile } from "../TransactionFile";
import { SourcesList } from "./sourcesList";
import { StoreSync } from "./storeSync";
import { StoreConfig } from "./storeConfig";
import { asDelayed, unwrapDelayed } from "./ArchivesDelayed";
import { logMutation, logStorageError, logStorageWarn } from "./storageLogs";

// The storage engine of the remote storage server. Data lives in synchronization sources (at minimum an ArchivesDisk, the local disk); BlobStore keeps an index of every file (path, last modified time, size, and which source currently holds the data) in a BulkDatabase2, and answers every read from it (see ArchivesSource in IArchives.ts). Keeping that index in agreement with the sources is StoreSync's job, not this file's; what lives here is the index itself, reads, writes, and the validation a write has to pass.

// Fast writes are never delayed past our own valid window, and within this margin of the window's end they write through immediately - so when the next window's source takes over, the writes are already on disk
export const WINDOW_END_FLUSH_MARGIN = timeInMinute * 5;
const WRONG_TARGET_LOG_THROTTLE = 60 * 1000;
// Marks an upload id that never reached the disk, so it can never collide with one ArchivesDisk handed out
const DISCARDED_UPLOAD_PREFIX = "discarded_";
// set refuses empty buffers, and an undelete carries no data - this single ignored byte satisfies the wire
const UNDELETE_PLACEHOLDER = Buffer.from([1]);

// Deletion history: deleted files keep their bytes on disk (marked in the index) until the history outgrows max(HISTORY_MIN_BYTES, live bytes * history factor) - see StoreSync.enforceHistoryLimit
export const HISTORY_MIN_BYTES = 10 * 1024 * 1024 * 1024;
const HISTORY_FACTOR = 1;
/** The multiple of a store's live bytes its deletion history may grow to. Async so it can later become dynamic and user-configurable; for now it is a constant. */
export async function getHistoryFactor(): Promise<number> {
    return HISTORY_FACTOR;
}


/** What we store about a file. Its times are not in here: the index keeps those for every key, deleted ones included (see TransactionFile). */
type IndexValue = {
    size: number;
    // Which synchronization source currently holds the data: the line number of the source's URL in the store's append-only sources list (see SourcesList) - NOT a position in the in-memory sources array, which changes between runs
    sourcesListIndex: number;
};

/** One file we hold, as everything outside the index sees it. */
export type IndexEntry = IndexValue & {
    writeTime: number;
    // When WE last changed this entry (not the file's write time) — what getChangesAfter2 filters on, so late-arriving files with old write times are still reported
    changedAt: number;
};

// One source of a live source-list update; see BlobStore.updateSources
export type BlobSourceSpec = {
    // Matched against ArchivesSource.identity ("disk" for the base slot); equal identities pair off in order
    identity: string;
    // See ArchivesSource.url
    url: string;
    validWindows: [number, number][];
    route?: [number, number];
    noFullSync?: boolean;
    // See ArchivesSource.intermediate
    intermediate?: string;
    // See ArchivesSource.sourceConfig (absent for the base disk source)
    sourceConfig?: SourceConfig;
    // Only called for sources that don't match an existing live slot
    create: () => IArchives;
    // The opposite case: the endpoint is already running and only its config changed, so the RUNNING source is handed the new one (see applySourceConfig)
    applyConfig?: (source: IArchives) => void;
};

let lastWrongTargetLog = 0;
function logWrongTargetRejection(message: string): void {
    if (Date.now() - lastWrongTargetLog < WRONG_TARGET_LOG_THROTTLE) return;
    lastWrongTargetLog = Date.now();
    logStorageError(message);
}

// The bucket store, and the only one: every bucket a server holds is served by these, one per store name in its routing config. Its sources are plain IArchives - the first is always the store's own disk folder, the rest are the configured peers (see createStoreSource) - so "no synchronization" is simply a store with no peers, not a different kind of store.
export class BlobStore {
    // ── state ──
    // Set once the store is shutting down; every loop it owns (and StoreSync's maintenance loops) stops on it
    public stopped = { stop: false };
    // Whether init has reached the point where a newly added source can start scanning immediately
    public syncStarted = false;
    /** Its sources, in config order: slot 0 is always its own disk folder, the rest are the peers it synchronizes with. Filled by updateSources, which is also how they change. The store OWNS them - writes pick among them, reads resolve holders through them - and StoreSync only scans whatever is in here at the time. */
    public sources: ArchivesSource[] = [];
    // Uploads immutability already decided against: the client is mid-stream by the time we know, so it keeps sending and every part is dropped
    private discardedUploads = new Set<string>();
    private nextDiscardedUpload = 1;
    // The persistent identities behind IndexEntry.sourcesListIndex (see SourcesList)
    private sourcesList: SourcesList;
    // Per slot: the persistent sourcesListIndex of that slot's URL, filled by registerSlot before the slot's sync runs
    private slotSourcesListIndexes: number[] = [];
    private slotRegistrations: Promise<void>[] = [];
    // Every file we know of, in memory, with an append-only log of the changes behind it (see TransactionFile). A new file name each time the entry format changes generation: the previous ones cannot be read, and a scan rebuilds the index anyway, so they are simply never read again.
    private index: TransactionFile<IndexValue>;
    /** Keeping the index in agreement with the sources: scanning, pulling, pushing, and the maintenance that follows from holding an index (disk-limit eviction, tombstone expiry). It reads and writes this store's index and sources - it does not own them. */
    public sync: StoreSync;

    constructor(
        // Public for StoreSync, which logs it with everything it does
        public folder: string,
        /** The name this store answers to (see CommonConfig.name) - the entries of the routing config that carry it are the ones that configure it, and the rest are its peers. */
        public storeName: string,
        private config?: {
            /** Whether a config entry is THIS SERVER (same account, same bucket, our own address). Injected because a store knows nothing about servers - it only needs to tell its own entries apart from its peers'. Absent means nothing is us, which is what a bare store (no server around it) wants. */
            isSelf?: (source: SourceConfig) => boolean;
            /** Builds one of its sources. Injected for the same reason, and because the delay it is created with is this store's policy. */
            createSource?: (config: { sourceConfig?: SourceConfig; writeDelay: number }) => IArchives;
            /** Hands a running source a changed config, so an endpoint we already talk to is never rebuilt just because a flag moved. */
            applySource?: (source: IArchives, sourceConfig: SourceConfig | undefined, writeDelay: number) => void;
            // Called whenever a key's index entry changes (our own writes AND files pulled in via synchronization) — how the storage server notices routing config updates.
            onIndexChanged?: (key: string) => void;
            /** Called every time this store applies a routing config to itself (startup, an operator's write, a peer's copy arriving) - the store is the one that knows when a config landed, and the server arms window-boundary scans from it. */
            onRoutingApplied?: (routing: RemoteConfig) => void;
            /** Asks the client whose request created this store what routing config it intended for our name. Only used when init finds NO configuration in our folder: a store only ever exists because a config names it, so the requester has that config - asking for it lazily is the same information as passing the config on every call, without the per-call kilobytes. */
            requestRoutingConfig?: () => Promise<RemoteConfig | undefined>;
            // Every accepted write ("original") and every write that actually reached the sources ("flushed"). Fast writes coalesce, so the two counts differ.
            onWriteCounted?: (kind: "original" | "flushed", bytes: number) => void;
            /** A synchronization transfer: "sync get" is bytes pulled off a source (the backblaze download bill), "sync set" is bytes pushed to one. Injected because sync traffic never passes through the API controller, so nothing else can count it. */
            onSyncTransfer?: (operation: "sync get" | "sync set", path: string, bytes: number) => void;
            // Resolves a persisted source URL (see ArchivesSource.url) to a cached IArchives, so entries whose holder is no longer configured can still be read
            resolveSourceUrl?: (url: string) => IArchives;
        }
    ) {
        this.sourcesList = new SourcesList(path.join(folder, "index", "sourcesList.txt"));
        this.index = new TransactionFile<IndexValue>(path.join(folder, "index", "blobIndex3.log"));
        this.sync = new StoreSync(this);
        this.storeConfig = new StoreConfig(storeName, []);
        this.ownDisk = new ArchivesDisk(folder);
    }

    /** This store's folder, unwrapped: the same bytes slot 0 serves, but reached without its write delay. Used for the two things that cannot go through a buffered source - reading our own routing config before we have any sources, and streaming a large upload that must not sit in memory. */
    private ownDisk: ArchivesDisk;

    /** What this store is configured to be. It owns this: the routing config is a file IN the store, so the store reads it, applies it to itself, and re-applies it whenever the file changes - by our own write, or by a peer's copy arriving through synchronization. */
    public storeConfig: StoreConfig;
    // The routing config this store last applied, so a write of an identical (or older) one is not re-applied
    private appliedRoutingVersion = -1;
    // ...and the config itself, so a rejection can say exactly what the store IS running instead of guessing
    private appliedRouting: RemoteConfig | undefined;

    // #region Main interface

    public init = lazy(async () => {
        // Configure first: the config decides what the sources ARE, and everything below is per source. With no config at all that is just our own disk, which is enough to serve and to be written to.
        await this.applyRoutingConfig();
        // No configuration in our folder at all - which happens when this store was just CREATED by a request, before any config write reached it. The requester knows exactly what config it intended for our name, so ask it.
        if (!this.storeConfig.all().length && this.config?.requestRoutingConfig) {
            try {
                let provided = await this.config.requestRoutingConfig();
                if (provided) {
                    console.log(`Store ${JSON.stringify(this.storeName)} (folder ${this.folder}) initialized with no configuration; the requesting client provided routing config version ${getConfigVersion(provided)} - adopting it`);
                    // Straight onto the disk, not through set(): set waits for init, which is what is running right now
                    await this.ownDisk.set(ROUTING_FILE, Buffer.from(serializeRemoteConfig(provided)), { lastModified: Math.round(Date.now()) });
                    await this.applyRoutingConfig();
                } else {
                    logStorageWarn(`Store ${JSON.stringify(this.storeName)} (folder ${this.folder}) initialized with no configuration, and the requesting client had no routing config naming it either - running unconfigured`);
                }
            } catch (e) {
                logStorageError(`Asking the requesting client for the routing config of store ${JSON.stringify(this.storeName)} (folder ${this.folder}) failed - running unconfigured: ${(e as Error).stack ?? e}`);
            }
        }
        for (let i = 0; i < this.sources.length; i++) {
            await this.registerSlot(i);
        }
        // After the slots, which is what index entries name as their holder
        await this.loadIndex();
        this.syncStarted = true;
        this.sync.start();
    });

    /**
     * Re-reads the routing config out of this store and applies it to itself. Called at startup and
     * whenever that file changes here - which is the ONE mechanism: a config written by an operator
     * and a config pulled off a peer are the same event, a write of that path into this store.
     *
     * A store with no routing config configures itself as its own disk, valid always, for the whole
     * key space. That is a complete, working store - it just has nobody to synchronize with - and it
     * is what lets a store exist before it has ever heard of a configuration.
     */
    public async applyRoutingConfig(): Promise<void> {
        let routing = await this.readRoutingConfig();
        let entries: HostedConfig[] = [];
        let peers: SourceConfig[] = [];
        for (let source of routing?.sources || []) {
            if (typeof source === "string") continue;
            if (source.name === this.storeName && this.config?.isSelf?.(source)) {
                entries.push(source as HostedConfig);
                continue;
            }
            peers.push(source);
        }
        if (routing && !entries.length) {
            logStorageWarn(`The routing config in store ${this.folder} (version ${getConfigVersion(routing)}) does not name this store (${JSON.stringify(this.storeName)}) as one of ours, so it stays a disk-only store`);
        }
        let previousVersion = this.appliedRoutingVersion;
        let newVersion = routing && getConfigVersion(routing) || -1;
        if (newVersion !== previousVersion) {
            console.log(`Store ${JSON.stringify(this.storeName)} (folder ${this.folder}) adopted routing config version ${previousVersion} -> ${newVersion}: ${entries.length} entr${entries.length === 1 && "y" || "ies"} of ours ${JSON.stringify(entries.map(x => ({ validWindow: x.validWindow, route: x.route || FULL_ROUTE })))}, ${peers.length} peer(s)`);
        }
        this.storeConfig.update(entries);
        this.updateSources(this.planSources(peers));
        this.appliedRoutingVersion = newVersion;
        this.appliedRouting = routing;
        if (routing) {
            this.config?.onRoutingApplied?.(routing);
        }
    }

    // The routing config as this store holds it, read straight off its folder: the store may be configuring itself before it has scanned anything, and this file is what decides what a scan would even talk to
    private async readRoutingConfig(): Promise<RemoteConfig | undefined> {
        let data = await this.ownDisk.get(ROUTING_FILE);
        if (!data || !data.length) return undefined;
        try {
            return parseRoutingData(data);
        } catch (e) {
            logStorageError(`Ignoring the routing config in store ${this.folder}: it could not be parsed: ${(e as Error).stack ?? e}`);
            return undefined;
        }
    }

    /** The version of the routing config this store is running, so a copy found on a peer is only taken when it is genuinely newer. -1 means it has none. */
    public routingVersion(): number {
        return this.appliedRoutingVersion;
    }

    // Applying it touches the sources, so it is serialized behind whatever application is already running rather than interleaving with it
    private routingApplies: Promise<void> = Promise.resolve();
    public reapplyRoutingConfig(): void {
        let next = this.routingApplies.then(() => this.applyRoutingConfig());
        this.routingApplies = next.catch(() => { });
        void next.catch((e: Error) => logStorageError(`Applying the routing config in store ${this.folder} failed: ${e.stack ?? e}`));
    }

    // Our own disk first (always), then every peer whose route overlaps ours - the sources this store synchronizes with, as its own config describes them
    private planSources(peers: SourceConfig[]): BlobSourceSpec[] {
        let self = this.storeConfig.current();
        let makeSpec = (sourceConfig: SourceConfig | undefined, validWindows: [number, number][], route: [number, number] | undefined, noFullSync: boolean | undefined): BlobSourceSpec => {
            let writeDelay = sourceWriteDelay({ sourceConfig, fast: self.fast, writeDelay: self.writeDelay });
            return {
                identity: sourceIdentity(sourceConfig),
                url: sourcePersistentUrl(sourceConfig, this.folder),
                validWindows,
                route,
                noFullSync,
                intermediate: sourceConfig?.intermediate,
                sourceConfig,
                create: () => {
                    let created = this.config?.createSource?.({ sourceConfig, writeDelay });
                    if (!created) {
                        throw new Error(`This store has no way to build sources, so it cannot use ${JSON.stringify(sourceConfig?.url || this.folder)} (store ${this.folder}). Pass createSource.`);
                    }
                    return created;
                },
                applyConfig: (source: IArchives) => this.config?.applySource?.(source, sourceConfig, writeDelay),
            };
        };
        // Our own disk accepts writes while ANY window this store holds is open; with no config at all it is simply always valid
        let ownWindows = this.storeConfig.all().map(x => x.validWindow);
        let specs: BlobSourceSpec[] = [makeSpec(undefined, ownWindows.length && ownWindows || [FULL_VALID_WINDOW], undefined, undefined)];
        // One spec per endpoint, carrying all of its windows: a switchover splits one window around an intermediate, and that is still one source to us
        let byIdentity = new Map<string, BlobSourceSpec>();
        for (let peer of peers) {
            let shared = routeIntersection(self.route, peer.route);
            if (!shared) continue;
            let identity = sourceIdentity(peer);
            let existing = byIdentity.get(identity);
            if (existing) {
                existing.validWindows.push(peer.validWindow);
                continue;
            }
            let spec = makeSpec(peer, [peer.validWindow], shared, peer.noFullSync || self.noFullSync);
            byIdentity.set(identity, spec);
            specs.push(spec);
        }
        return specs;
    }

    // Stops all synchronization scans/polls and flushes pending writes. Only used when the store genuinely cannot continue (its route or disk limit changed, process shutdown) - routine config changes go through updateSources instead, which the store survives.
    public async dispose(): Promise<void> {
        this.stopped.stop = true;
        this.sync.stop();
        await this.flushDelayedWrites(true);
        await this.index.flush();
    }

    public async get2(config: { path: string; range?: { start: number; end: number }; internal?: boolean; includeTombstones?: boolean; includeMarked?: boolean }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        if (config.internal) {
            return await this.getInternal2(config);
        }
        await this.init();
        let key = config.path;
        let range = config.range;
        // Not in the index means it does not exist here: the index IS the answer, and scanning heals it on its own schedule. An entry whose holder is no longer in the source list is still valid - getEntryHolder resolves the persisted URL directly, and get2's fallback loop covers a holder that is gone entirely.
        let entry = this.getIndexEntry(key);
        // A marked deletion still has its bytes, and the kept value says where - so an includeMarked read is a normal read through the marked entry (it just must not RE-INDEX anything: see the markedRead guards below)
        let markedRead = false;
        if (!entry && config.includeMarked) {
            entry = this.getMarkedEntry(key);
            markedRead = !!entry;
        }
        if (!entry) {
            if (!config.includeTombstones) return undefined;
            // A deletion has no bytes - the tombstone IS the answer, so a flag-caller gets its time with empty data
            let deleted = this.getDeletedEntry(key);
            if (!deleted) return undefined;
            return { data: Buffer.alloc(0), writeTime: deleted.writeTime, size: 0 };
        }
        this.sync.noteAccess(key);
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
            // Ranged reads can't populate a cache (they're partial), and a marked read must not re-index anything - caching would resurrect the deleted key as live
            if (!markedRead && this.slotForSourcesListIndex(entry.sourcesListIndex) !== 0 && !range) {
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
            // A marked read must not re-index anything - caching would resurrect the deleted key as live
            if (!markedRead) {
                await this.cacheRead(key, fallback);
            }
            let data = fallback.data;
            if (range) {
                data = data.subarray(Math.min(range.start, data.length), Math.min(range.end, data.length));
            }
            return { data, writeTime: fallback.writeTime, size: fallback.size };
        }
        if (holderError) throw holderError;
        // The holder answered "not there" and no other source has it either: the entry was stale. Forgotten rather than deleted - nothing happened to this file, we were simply wrong about holding it, and saying otherwise would push a deletion out to everyone else. (Never for a marked read: purging would erase the deletion's tombstone.)
        if (!markedRead) {
            this.purgeIndexEntry(key);
        }
        return undefined;
    }

    public async set(config: { path: string; data: Buffer; lastModified?: number; forceSetImmutable?: boolean; internal?: boolean; undelete?: boolean }): Promise<void> {
        let { path: key, data } = config;
        if (!data.length) {
            throw new Error(`Empty write refused: set was called with an empty buffer for ${JSON.stringify(key)} (store ${this.folder}): an empty file IS a deletion in this system and would read back as missing - call del instead`);
        }
        await this.init();
        let writeTime = Math.round(config.lastModified || Date.now());
        let route = getRoute(key);
        // The routing file defines the windows/routes, so they can't possibly apply to it (and it never flows through validation) - but it has a rule of its own, which is ours to enforce because the file is ours
        if (key === ROUTING_FILE) {
            this.assertRoutingConfigWritable(data);
        } else {
            this.assertWriteTarget(key, route, config.lastModified);
        }
        if (config.undelete) {
            if (key === ROUTING_FILE) {
                throw new Error(`The routing config ${JSON.stringify(ROUTING_FILE)} cannot be undeleted (it cannot be deleted in the first place)`);
            }
            await this.undeleteKey(key, writeTime, config.internal);
            return;
        }
        if (key !== ROUTING_FILE && this.storeConfig.all().length) {
            if (config.forceSetImmutable) {
                if (!config.lastModified) {
                    throw new Error(`forceSetImmutable requires lastModified (synchronization writes are ordered by their write time), writing ${JSON.stringify(key)} (store ${this.folder})`);
                }
                // Immutability wins: an existing path is kept instead of the push throwing (see SetConfig.forceSetImmutable)
                let self = selectEntryAt(this.storeConfig.all(), writeTime, route);
                if (self?.immutable && await this.getInfo({ path: key })) return;
            } else {
                await this.assertMutable(key, writeTime);
            }
        }
        if (config.internal) {
            if (!config.lastModified) {
                throw new Error(`Internal writes must carry lastModified (they are synchronization pushes, ordered by their write time), writing ${JSON.stringify(key)} (store ${this.folder})`);
            }
            // The routing file is exempt for the same reason it skips every other check: it is the file that DEFINES our windows and routes, so judging it by the config it is about to replace is how a store gets stuck on a config it can never be told to leave
            if (key !== ROUTING_FILE) {
                this.assertInternalWriteAccepted(key, config.lastModified, route);
            }
            await this.setInternal(key, data, { lastModified: config.lastModified });
            return;
        }
        await this.setOrDelete(key, data, { lastModified: config.lastModified });
    }

    public async del(config: { path: string; lastModified?: number; internal?: boolean }): Promise<void> {
        let key = config.path;
        if (key === ROUTING_FILE) {
            throw new Error(`The routing config ${JSON.stringify(ROUTING_FILE)} cannot be deleted (overwrite it to change the bucket's configuration)`);
        }
        await this.init();
        // A deletion lands in exactly the same place a write would, so it is judged the same way: one aimed at a shard we don't serve is just as invisible as a write to it
        this.assertWriteTarget(key, getRoute(key), config.lastModified);
        if (config.internal) {
            if (!config.lastModified) {
                throw new Error(`Internal deletions must carry lastModified (they are synchronization pushes, ordered by their write time), deleting ${JSON.stringify(key)} (store ${this.folder})`);
            }
            this.assertInternalWriteAccepted(key, config.lastModified, getRoute(key));
            // setInternal treats an empty buffer as exactly a deletion: disk removal plus a tombstone index entry, no fan-out
            await this.setInternal(key, Buffer.alloc(0), { lastModified: config.lastModified });
            return;
        }
        // Deletes are writes (an empty file IS a missing file): the tombstone is ordered by write time like any other write, propagates through synchronization, and is eventually expired
        await this.setOrDelete(key, Buffer.alloc(0), { lastModified: config.lastModified });
    }

    /** A node-side move: the bytes never travel through the client. Deliberately just get2 + set + del rather than a disk rename, so the destination write passes EVERY rule a set passes (windows, routes, immutability, only-take-latest, index, fan-out to peers) and the deletion propagates as a normal tombstone - a rename would bypass all of it. The set stamps fresh, so the moved file beats any tombstone at its new path. */
    public async move(config: { fromPath: string; toPath: string }): Promise<void> {
        await this.init();
        if (config.fromPath === config.toPath) return;
        if (config.fromPath === ROUTING_FILE || config.toPath === ROUTING_FILE) {
            throw new Error(`The routing config ${JSON.stringify(ROUTING_FILE)} cannot be moved (store ${this.folder})`);
        }
        let result = await this.get2({ path: config.fromPath });
        if (!result || !result.data.length) {
            throw new Error(`Move source does not exist. Cannot move ${JSON.stringify(config.fromPath)} to ${JSON.stringify(config.toPath)} (store ${this.folder})`);
        }
        await this.set({ path: config.toPath, data: result.data });
        await this.del({ path: config.fromPath });
        logMutation({ op: "move", folder: this.folder, store: this.storeName, path: config.fromPath, toPath: config.toPath, size: result.data.length });
    }

    public async getInfo(config: { path: string; includeTombstones?: boolean }): Promise<{ writeTime: number; size: number } | undefined> {
        await this.init();
        let key = config.path;
        // Not in the index means it does not exist here: the index IS the answer, and scanning heals it on its own schedule. An entry whose holder is no longer in the source list is still valid - getEntryHolder resolves the persisted URL directly, and get2's fallback loop covers a holder that is gone entirely.
        let entry = this.getIndexEntry(key);
        if (entry) return { writeTime: entry.writeTime, size: entry.size };
        if (!config.includeTombstones) return undefined;
        let deleted = this.getDeletedEntry(key);
        if (!deleted) return undefined;
        return { writeTime: deleted.writeTime, size: 0 };
    }

    public async findInfo(config: FindConfig & { prefix: string }): Promise<ArchiveFileInfo[]> {
        await this.init();
        await this.sync.waitForRequiredScans();
        let prefix = config.prefix;
        let infos = new Map<string, ArchiveFileInfo>();
        // Deletions are not in here at all, which is what a listing wants: an empty file IS a missing file
        for (let [key, entry] of this.indexEntries()) {
            if (!key.startsWith(prefix)) continue;
            infos.set(key, { path: key, createTime: entry.writeTime, size: entry.size });
        }
        if (config.includeMarked) {
            // A key is live OR marked, never both, so this cannot collide with the loop above
            for (let [key, entry] of this.markedEntries()) {
                if (!key.startsWith(prefix)) continue;
                infos.set(key, { path: key, createTime: entry.writeTime, size: entry.size });
            }
        }
        let files = applyFindInfoShape(Array.from(infos.values()), prefix, { shallow: config.shallow, type: config.type });
        sort(files, x => x.path);
        return files;
    }

    // All files changed after config.time — straight from the index. Filters on when WE learned of the change (changedAt), so files synchronized late (with old write times) are still reported. Deletions ARE reported, as size-0 entries: a caller reading a change feed has to hear about them, and size 0 is how the feed says "gone" (an empty file IS a missing file). config.routes lets a store syncing a partial shard ask for just its slice.
    public async getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]> {
        await this.init();
        await this.sync.waitForRequiredScans();
        let inRoutes = (key: string) => !config.routes || config.routes.some(route => routeContains(route, getRoute(key)));
        let files: ArchiveFileInfo[] = [];
        for (let [key, entry] of this.indexEntries()) {
            if (entry.changedAt <= config.time) continue;
            if (!inRoutes(key)) continue;
            files.push({ path: key, createTime: entry.writeTime, size: entry.size });
        }
        for (let [key, tombstone] of this.deletedEntries()) {
            if (tombstone.changedAt <= config.time) continue;
            if (!inRoutes(key)) continue;
            files.push({ path: key, createTime: tombstone.writeTime, size: 0 });
        }
        sort(files, x => x.path);
        return files;
    }

    public async getSyncStatus(): Promise<ArchivesSyncStatus> {
        await this.init();
        return this.sync.getStatus();
    }

    /** The index's totals plus any in-progress background synchronization. */
    public getSyncProgress(): {
        index: { fileCount: number; byteCount: number };
        marked: { fileCount: number; byteCount: number; oldestDeleteTime?: number };
        sources: { debugName: string; fileCount: number; byteCount: number }[];
        readerDiskLimit?: number;
        syncing: SyncActivity[];
    } {
        let totals = this.namedIndexTotals();
        return {
            index: { fileCount: totals.fileCount, byteCount: totals.byteCount },
            marked: this.markedTotals(),
            sources: totals.sources,
            readerDiskLimit: this.readerDiskLimit,
            syncing: this.sync.getActivities(),
        };
    }

    /** getSyncProgress's totals, but loading the index first, so they are never the zeroes of a store nothing has touched yet. */
    public async computeIndexTotals(): Promise<{
        fileCount: number;
        byteCount: number;
        sources: { debugName: string; fileCount: number; byteCount: number }[];
    }> {
        await this.init();
        return this.namedIndexTotals();
    }

    private namedIndexTotals(): { fileCount: number; byteCount: number; sources: { debugName: string; fileCount: number; byteCount: number }[] } {
        let totals = this.indexTotals();
        return {
            fileCount: totals.fileCount,
            byteCount: totals.byteCount,
            sources: this.sources
                .map((x, i) => ({ debugName: x.source.getDebugName(), ...totals.slots[i] }))
                .filter((x, i) => this.isLive(i)),
        };
    }

    /**
     * The store's sources, as the current routing config says they should be. This is the ONLY way
     * they are ever set: the first call populates an empty store, every later one applies a change to
     * the running one. Windows, routes and flags move in place, genuinely new endpoints are added and
     * start scanning, and endpoints that are gone go dead (their scans stop, their index entries
     * drop).
     *
     * A store is never rebuilt for a config change. Its name decides its folder and its identity, and
     * a config change cannot change either - so there is nothing a change can do to a store except
     * this.
     */
    public updateSources(specs: BlobSourceSpec[]): void {
        if (!specs.length || specs[0].identity !== "disk") {
            throw new Error(`updateSources expects the disk source first (identity "disk"), got ${JSON.stringify(specs.map(x => x.identity))} (store ${this.folder})`);
        }
        if (!this.sources.length) {
            // First call: the disk slot has to exist before anything can be matched against it
            let disk = specs[0];
            let source = disk.create();
            asDelayed(source)?.bindFlushDeadline(() => this.writeFlushDeadline());
            this.sources.push({ source, url: disk.url, validWindows: disk.validWindows, route: disk.route, noFullSync: disk.noFullSync, sourceConfig: disk.sourceConfig, identity: disk.identity });
            this.sync.addSource(0);
        }
        let setWindows = (i: number, windows: [number, number][]) => {
            let old = this.sources[i].validWindows;
            if (JSON.stringify(old) === JSON.stringify(windows)) return;
            console.log(`Valid windows changed for ${this.sources[i].source.getDebugName()} (store ${this.folder}): ${JSON.stringify(old)} -> ${JSON.stringify(windows)}`);
            this.sources[i].validWindows = windows;
        };
        setWindows(0, specs[0].validWindows);
        // Live slots pair with specs by identity. Each endpoint is now ONE spec carrying all its windows, so this is a 1:1 pairing; any leftover duplicate slots from before (an endpoint that used to be split into several slots) go unmatched below and are collapsed away.
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
                // The SAME endpoint (see sourceIdentity), so we are already synchronized with it: the slot keeps its connection, its completed scans, and its index entries, and only the policy on it moves. Recreating it here would mean rescanning the endpoint from scratch every time a flag changes.
                matched.add(slot);
                setWindows(slot, spec.validWindows);
                let existing = this.sources[slot];
                if (JSON.stringify(existing.route) !== JSON.stringify(spec.route)) {
                    console.log(`Route changed for ${existing.source.getDebugName()} (store ${this.folder}): ${JSON.stringify(existing.route)} -> ${JSON.stringify(spec.route)}`);
                    existing.route = spec.route;
                }
                if (JSON.stringify(existing.sourceConfig) !== JSON.stringify(spec.sourceConfig)) {
                    console.log(`Config changed for ${existing.source.getDebugName()} (store ${this.folder}), keeping the source (so it is not rescanned): ${JSON.stringify(existing.sourceConfig)} -> ${JSON.stringify(spec.sourceConfig)}`);
                }
                // The source carries its config (and its write delay) into everything it does, so it has to learn the new one - see applySourceConfig
                spec.applyConfig?.(existing.source);
                existing.noFullSync = spec.noFullSync;
                existing.sourceConfig = spec.sourceConfig;
                continue;
            }
            let source = spec.create();
            asDelayed(source)?.bindFlushDeadline(() => this.writeFlushDeadline());
            this.sources.push({ source, url: spec.url, validWindows: spec.validWindows, route: spec.route, noFullSync: spec.noFullSync, intermediate: spec.intermediate, sourceConfig: spec.sourceConfig, identity: spec.identity });
            console.log(`Added sync source ${source.getDebugName()} (store ${this.folder}): a genuinely new endpoint, so it is scanned from scratch`);
            this.sync.addSource(this.sources.length - 1);
        }
        for (let i = 1; i < originalLength; i++) {
            if (!this.isLive(i) || matched.has(i)) continue;
            // The slot is dead the moment this returns; dropping the index entries it held is the part that reads the index, so it finishes in the background
            void this.sync.removeSource(i).catch((e: Error) => logStorageError(`Removing sync source ${this.sources[i].source.getDebugName()} (store ${this.folder}) failed: ${e.stack ?? e}`));
        }
    }

    /** Rescans our own disk's metadata into the index - used around valid window handoffs, where another process wrote files to the shared folder that our index hasn't seen. */
    public async rescanBase(): Promise<void> {
        await this.init();
        await this.sync.rescanBase();
    }

    /** A boundary scan of the node that owned (part of) our route in the valid window before ours, when that node is different storage (a disk rescan can't see its writes). */
    public async boundaryScanRemote(source: IArchives, config: { since: number; route?: [number, number] }): Promise<void> {
        await this.init();
        await this.sync.boundaryScanRemote(source, config);
    }

    // Large uploads stream onto the local disk source directly (they may not fit in memory), and reconciliation carries them to the other sources - there is no delayed-write stage they could pass through. The write itself is validated exactly like set's, right here: the client is about to send the whole file, so every reason to refuse it must be found before the first byte.
    public async startLargeUpload(config?: { path?: string; lastModified?: number; forceSetImmutable?: boolean; noChecks?: boolean; internal?: boolean }): Promise<string> {
        await this.init();
        let key = config?.path;
        if (key) {
            let writeTime = Math.round(config?.lastModified || Date.now());
            let route = getRoute(key);
            if (key !== ROUTING_FILE) {
                this.assertWriteTarget(key, route, config?.lastModified);
            }
            if (key !== ROUTING_FILE && this.storeConfig.all().length) {
                if (config?.forceSetImmutable) {
                    if (!config.lastModified) {
                        throw new Error(`forceSetImmutable requires lastModified (synchronization writes are ordered by their write time), uploading ${JSON.stringify(key)} (store ${this.folder})`);
                    }
                    // Immutability wins: an existing path is kept instead of the push throwing (see SetConfig.forceSetImmutable). The client is already streaming, so the upload is accepted and every part discarded - the alternative is throwing at a caller that did nothing wrong.
                    let self = selectEntryAt(this.storeConfig.all(), writeTime, route);
                    if (self?.immutable && await this.getInfo({ path: key })) {
                        let id = `${DISCARDED_UPLOAD_PREFIX}${this.nextDiscardedUpload++}`;
                        this.discardedUploads.add(id);
                        return id;
                    }
                } else {
                    await this.assertMutable(key, writeTime);
                }
            }
            if (config?.internal) {
                if (!config.lastModified) {
                    throw new Error(`Internal writes must carry lastModified (they are synchronization pushes, ordered by their write time), uploading ${JSON.stringify(key)} (store ${this.folder})`);
                }
                this.assertInternalWriteAccepted(key, config.lastModified, route);
            }
        }
        return await this.getDiskSource().disk.startLargeUpload();
    }
    public async appendLargeUpload(config: { id: string; data: Buffer; offset?: number }): Promise<void> {
        if (this.discardedUploads.has(config.id)) return;
        await this.getDiskSource().disk.appendLargeUpload(config.id, config.data, config.offset);
    }
    public async finishLargeUpload(config: { id: string; path: string; lastModified?: number; forceSetImmutable?: boolean; noChecks?: boolean; internal?: boolean }): Promise<void> {
        if (this.discardedUploads.delete(config.id)) return;
        let { disk, sourceIndex } = this.getDiskSource();
        if (config.lastModified) {
            assertValidLastModified(config.lastModified);
            // An older write never overwrites a newer one (see IArchives.set) - a newer value can land while a long upload is still streaming, so this is re-checked here rather than only at the start
            if (config.lastModified < await this.currentWriteTime(config.path)) {
                await disk.cancelLargeUpload(config.id);
                return;
            }
        }
        await disk.finishLargeUpload(config.id, config.path, config.lastModified);
        let info = await disk.getInfo(config.path);
        if (info) {
            this.setIndexEntry(config.path, { writeTime: info.writeTime, size: info.size, sourcesListIndex: this.sourcesListIndexOfSlot(sourceIndex) });
            logMutation({ op: "setLarge", folder: this.folder, store: this.storeName, path: config.path, size: info.size, writeTime: info.writeTime, internal: config.internal });
        }
    }
    public async cancelLargeUpload(config: { id: string }): Promise<void> {
        if (this.discardedUploads.delete(config.id)) return;
        await this.getDiskSource().disk.cancelLargeUpload(config.id);
    }

    // #endregion

    // #region Internals

    /** Bytes of read cache the disk may hold; see CommonConfig.readerDiskLimit (StoreSync enforces it). Read from the config in effect, so raising or removing the limit takes effect on the next eviction pass. */
    public get readerDiskLimit(): number | undefined {
        return this.storeConfig.current().readerDiskLimit;
    }

    /** The write time a new write has to beat, or 0 when we have never heard of the key. Counts DELETIONS too: a write older than the deletion that removed it must not bring it back. The index is authoritative even for a write still buffered in a delayed source, since the entry is recorded when the write is accepted rather than when it reaches storage. */
    public currentWriteTime(key: string): number {
        return this.index.timeOf(key);
    }

    private isLive(sourceIndex: number): boolean {
        return this.sync.isLive(sourceIndex);
    }

    public registerSlot(slot: number): Promise<void> {
        let existing = this.slotRegistrations[slot];
        if (existing) return existing;
        let registration = this.sourcesList.ensure(this.sources[slot].url).then(index => {
            this.slotSourcesListIndexes[slot] = index;
        });
        this.slotRegistrations[slot] = registration;
        return registration;
    }

    /** The persistent sourcesListIndex of a slot, or undefined when the slot never got that far (a source removed before its registration resolved). */
    public slotSourcesListIndex(slot: number): number | undefined {
        return this.slotSourcesListIndexes[slot];
    }

    // The persistent sourcesListIndex of a slot - only valid once the slot's registration resolved (init and the source's sync loop guarantee that before any indexing happens)
    public sourcesListIndexOfSlot(slot: number): number {
        let index = this.slotSourcesListIndexes[slot];
        if (index === undefined) {
            throw new Error(`Source slot is not registered yet. Slot ${slot} (${this.sources[slot]?.url}) has no sourcesListIndex (store ${this.folder})`);
        }
        return index;
    }

    // The live slot currently serving a persistent sourcesListIndex, or undefined when no configured source has that URL anymore. Linear, but the sources list is tiny and this is always current (slots dying, or several slots sharing one URL across valid windows, need no bookkeeping).
    public slotForSourcesListIndex(sourcesListIndex: number): number | undefined {
        for (let i = 0; i < this.slotSourcesListIndexes.length; i++) {
            if (this.slotSourcesListIndexes[i] === sourcesListIndex && this.isLive(i)) return i;
        }
        return undefined;
    }

    // The IArchives currently holding an entry's bytes: the live slot when the holder is still configured, otherwise resolved (cached) straight from its persisted URL - windows/routes decide when a source is scanned or written, but for reading bytes we know it holds, the URL alone is enough
    public async getEntryHolder(entry: IndexEntry): Promise<IArchives | undefined> {
        let slot = this.slotForSourcesListIndex(entry.sourcesListIndex);
        if (slot !== undefined) return this.sources[slot].source;
        let url = this.sourcesList.getUrl(entry.sourcesListIndex) || await this.sourcesList.getUrlReloading(entry.sourcesListIndex);
        if (!url) return undefined;
        return this.config?.resolveSourceUrl?.(url);
    }

    private async loadIndex(): Promise<void> {
        await this.index.load();
        // The routing config is only ever read off our own disk (see StoreSync's scan handling), and a loaded bucket always has it there - a persisted entry pointing elsewhere is stale, so it is corrected once, here
        let routing = this.getIndexEntry(ROUTING_FILE);
        let baseSourcesListIndex = this.sourcesListIndexOfSlot(0);
        if (routing && routing.sourcesListIndex !== baseSourcesListIndex) {
            this.setIndexEntry(ROUTING_FILE, { writeTime: routing.writeTime, size: routing.size, sourcesListIndex: baseSourcesListIndex });
        }
    }

    /** A file we hold. A deleted one is not one: it is a tombstone, and only getDeletedEntry knows about it. */
    public getIndexEntry(key: string): IndexEntry | undefined {
        let entry = this.index.get(key);
        if (!entry) return undefined;
        return { ...entry.value, writeTime: entry.time, changedAt: entry.changedAt };
    }

    /** When a key was deleted, if it was. A deletion is an absence with a time attached - that time is what makes it propagate and what expires it. */
    public getDeletedEntry(key: string): { writeTime: number; changedAt: number } | undefined {
        let tombstone = this.index.getDeleted(key);
        if (!tombstone) return undefined;
        return { writeTime: tombstone.time, changedAt: tombstone.changedAt };
    }

    /** Every file we hold, for the passes that walk them all (listings, scans, reconciliation, eviction). Deletions are not in here - see deletedEntries. Live: deleting entries while iterating is expected here, and safe. */
    public *indexEntries(): IterableIterator<[string, IndexEntry]> {
        for (let [key, entry] of this.index.entries()) {
            yield [key, { ...entry.value, writeTime: entry.time, changedAt: entry.changedAt }];
        }
    }

    /** Every deletion we know of. A much smaller walk than the files, which is what makes expiring them cheap. */
    public *deletedEntries(): IterableIterator<[string, { writeTime: number; changedAt: number }]> {
        for (let [key, tombstone] of this.index.deletedEntries()) {
            yield [key, { writeTime: tombstone.time, changedAt: tombstone.changedAt }];
        }
    }

    /** A file MARKED for deletion: its kept index value plus when it was deleted. Undefined when the key is live, never existed, or its history was already dropped. */
    public getMarkedEntry(key: string): (IndexEntry & { deleteTime: number }) | undefined {
        let tombstone = this.index.getDeleted(key);
        if (!tombstone || tombstone.value === undefined) return undefined;
        return { ...tombstone.value, writeTime: tombstone.valueTime || tombstone.time, changedAt: tombstone.changedAt, deleteTime: tombstone.time };
    }

    /** Every file marked for deletion - the deletion history, walked by retention and by includeMarked listings. */
    public *markedEntries(): IterableIterator<[string, IndexEntry & { deleteTime: number }]> {
        for (let [key, tombstone] of this.index.deletedEntries()) {
            if (tombstone.value === undefined) continue;
            yield [key, { ...tombstone.value, writeTime: tombstone.valueTime || tombstone.time, changedAt: tombstone.changedAt, deleteTime: tombstone.time }];
        }
    }

    /** The deletion history's totals: how many marked files, their bytes, and the delete time of the OLDEST one - which is how far back the history reaches. */
    public markedTotals(): { fileCount: number; byteCount: number; oldestDeleteTime?: number } {
        let fileCount = 0;
        let byteCount = 0;
        let oldestDeleteTime: number | undefined;
        for (let [, entry] of this.markedEntries()) {
            fileCount++;
            byteCount += entry.size;
            if (oldestDeleteTime === undefined || entry.deleteTime < oldestDeleteTime) {
                oldestDeleteTime = entry.deleteTime;
            }
        }
        return { fileCount, byteCount, oldestDeleteTime };
    }

    /** Physically removes a marked file's bytes from our disk and drops its kept value, leaving a plain tombstone that ages out normally - retention calling time on the oldest history. */
    public async dropMarkedHistory(key: string): Promise<void> {
        await this.ownDisk.del(key);
        this.index.dropValue(key);
    }

    /** See SetConfig.undelete: flips a marked deletion back to live (fresh write time, so the restore outranks the deletion everywhere it propagated) - the bytes never left the disk, so reads just work again. Internal restores are a peer's propagation and tolerate having nothing to restore (this node may never have held the file); a caller's restore throws instead. */
    private async undeleteKey(key: string, writeTime: number, internal: boolean | undefined): Promise<void> {
        let marked = this.getMarkedEntry(key);
        if (!this.index.unmark(key, writeTime)) {
            // Already live: undelete is idempotent (retries and peer propagation both re-send it)
            if (this.getIndexEntry(key)) return;
            if (internal) {
                console.log(`Undelete of ${JSON.stringify(key)} (store ${this.folder}) has nothing to restore here - this node may never have held the file`);
                return;
            }
            throw new Error(`Undelete failed - nothing to restore. Cannot undelete ${JSON.stringify(key)} (store ${this.folder}): it has no marked deletion to restore - it was never deleted here${this.getDeletedEntry(key) && ", or its deletion history was already dropped (a plain tombstone remains, but the bytes are gone)" || ""}`);
        }
        console.log(`Undeleted ${JSON.stringify(key)} (store ${this.folder}): the index entry (${marked?.size} bytes, deleted ${marked && formatDateTimeDetailed(marked.deleteTime)}) is live again as of ${formatDateTimeDetailed(writeTime)} - the bytes never left the disk`);
        logMutation({ op: "undelete", folder: this.folder, store: this.storeName, path: key, size: marked?.size, writeTime, internal });
        this.config?.onIndexChanged?.(key);
        if (internal) return;
        // Peers marked their own copies when the deletion propagated, so the restore propagates the same way. Straight past any write delay - a buffered undelete could be read back as its placeholder byte.
        let route = getRoute(key);
        for (let i of this.getWritableSources()) {
            if (i === 0) continue;
            if (!routeContains(this.sources[i].route, route)) continue;
            // Only our own servers understand the flag - a raw source (backblaze) would store the placeholder byte as the file. Their older copy is re-pushed by reconciliation instead.
            if (this.sources[i].sourceConfig?.type !== "remote") continue;
            let push = unwrapDelayed(this.sources[i].source).set(key, UNDELETE_PLACEHOLDER, { lastModified: writeTime, undelete: true, noChecks: true, internal: true });
            void push.catch((e: Error) => {
                logStorageError(`Background undelete of ${key} on sync source ${this.sources[i].source.getDebugName()} (store ${this.folder}) failed (its scan of us re-finds the file anyway): ${e.stack ?? e}`);
            });
        }
    }

    /** How many files we hold, deletions excluded. */
    public indexSize(): number {
        return this.index.size;
    }

    /** Totals over the files we hold, broken down by the slot holding each (entries can name a source that is no longer configured, which counts towards the total but no slot). */
    public indexTotals(): { fileCount: number; byteCount: number; slots: { fileCount: number; byteCount: number }[] } {
        let fileCount = 0;
        let byteCount = 0;
        let slots = this.sources.map(() => ({ fileCount: 0, byteCount: 0 }));
        for (let [, entry] of this.indexEntries()) {
            fileCount++;
            byteCount += entry.size;
            let slot = this.slotForSourcesListIndex(entry.sourcesListIndex);
            if (slot === undefined) continue;
            slots[slot].fileCount++;
            slots[slot].byteCount += entry.size;
        }
        return { fileCount, byteCount, slots };
    }

    /** Records a file, as of its write time. Returns false, having changed nothing, when we already know something at least as new - the index cannot be made to go backwards, whichever path the write came in by. */
    public setIndexEntry(key: string, entry: { writeTime: number; size: number; sourcesListIndex: number }): boolean {
        if (!this.index.set(key, { size: entry.size, sourcesListIndex: entry.sourcesListIndex }, entry.writeTime)) return false;
        // The routing config landing here - written by an operator, or pulled off a peer by synchronization - is how this store learns what it is meant to be
        if (key === ROUTING_FILE && this.syncStarted) {
            this.reapplyRoutingConfig();
        }
        this.config?.onIndexChanged?.(key);
        return true;
    }

    /** Records a DELETION, as of its time: the key stops existing here, and the tombstone is what makes that fact propagate and reconcile like any other write. Same ordering rule as setIndexEntry. */
    public setIndexDeleted(key: string, writeTime: number): boolean {
        if (!this.index.delete(key, writeTime)) return false;
        this.config?.onIndexChanged?.(key);
        return true;
    }

    /** Forgets a key entirely, tombstone included. NOT a deletion: it says nothing happened to the file, only that we no longer know anything about it - for an entry whose holder turned out not to have it, and for a tombstone old enough that everyone has heard. */
    public purgeIndexEntry(key: string): void {
        this.index.purge(key);
    }

    /** Counts a synchronization transfer in the server's access statistics (see getStore's wiring): "sync get" for bytes pulled off a source, "sync set" for bytes pushed to one. */
    public noteSyncTransfer(operation: "sync get" | "sync set", path: string, bytes: number): void {
        logMutation({ op: operation, folder: this.folder, store: this.storeName, path, size: bytes });
        this.config?.onSyncTransfer?.(operation, path, bytes);
    }

    // ── validation (from this store's own routing entries) ──

    /**
     * Every write, however it is stamped, has to be one we are actually meant to hold - because the
     * alternative is not a smaller problem, it is a silent one. A write that lands on a store that
     * does not serve its route (or on a server that is not in the bucket's config at all) goes into a
     * folder nothing scans and no peer reconciles: it succeeds, and then it is gone. The markers make
     * the client re-read the routing config and retry, which is exactly the right outcome when the
     * reason it aimed here is that its config was stale.
     */
    private assertWriteTarget(key: string, route: number, lastModified: number | undefined): void {
        if (!this.storeConfig.all().length) {
            let detail = this.unconfiguredDetail();
            logWrongTargetRejection(`Rejecting write of ${JSON.stringify(key)}: ${detail}`);
            throw new Error(`${STORAGE_NOT_CONFIGURED} Write rejected: this store has no configuration. Cannot write ${JSON.stringify(key)}: ${detail} Data written to a store with no configuration entry would never be scanned or reconciled, so accepting it would silently lose it. Re-resolve the currently valid source and retry - or, if this store is genuinely meant to take this write, write the bucket's routing config with an entry naming it on this server.`);
        }
        if (!lastModified) {
            this.assertFreshWriteTarget(key, Date.now(), route);
            return;
        }
        // A stamped write picked its own time, so no window can judge it (that is the whole point of a synchronized write) - but the ROUTE is not a matter of timing, and a stamped write to the wrong shard is exactly as invisible as a fresh one
        if (this.storeConfig.all().some(x => routeContains(x.route, route))) return;
        logWrongTargetRejection(`Rejecting stamped write of ${JSON.stringify(key)} (store ${this.folder}): route ${route} is outside every route we serve ${JSON.stringify(this.storeConfig.all().map(x => x.route || FULL_ROUTE))}`);
        throw new Error(`${STORAGE_WRONG_ROUTE} Write rejected: wrong route for this store. Route ${route} (key ${JSON.stringify(key)}, our routes: ${JSON.stringify(this.storeConfig.all().map(x => x.route || FULL_ROUTE))}, store ${this.folder}). Re-resolve the source for this key and retry.`);
    }

    /** Exactly why this store has no configuration entries - which of the three possible reasons it is, with the values that decided it, because "not configured" alone is undiagnosable. */
    private unconfiguredDetail(): string {
        let routing = this.appliedRouting;
        let identity = `store ${JSON.stringify(this.storeName)} (folder ${this.folder})`;
        if (!routing) {
            return `${identity} has no routing config at all - nothing has ever written ${JSON.stringify(ROUTING_FILE)} into it.`;
        }
        let objects = routing.sources.filter(x => typeof x !== "string") as SourceConfig[];
        let named = objects.filter(x => x.name === this.storeName);
        if (!named.length) {
            return `${identity} is running routing config version ${getConfigVersion(routing)}, which has no entry named ${JSON.stringify(this.storeName)} (its entries are named ${JSON.stringify(objects.map(x => x.name))}).`;
        }
        return `${identity} is running routing config version ${getConfigVersion(routing)}, whose ${named.length} entr${named.length === 1 && "y" || "ies"} named ${JSON.stringify(this.storeName)} point(s) at ${JSON.stringify(named.map(x => x.url))} - none of which is THIS server, so the config says this store lives elsewhere.`;
    }

    /**
     * Whether a routing config may be written here. Two rules, and this is the one place either is
     * applied - a config only ever enters the system through a write, so a config that got in is a
     * config that passed, and reading one back never judges it again.
     *
     * The config has to be valid as a whole (see assertValidRemoteConfig), and it has to outrank what
     * we are running: the same version means the same config, so re-writing it is harmless, but a
     * lower one is an older config arriving late and must never undo a newer one.
     */
    private assertRoutingConfigWritable(data: Buffer): void {
        let routing = parseRoutingData(data);
        assertValidRemoteConfig(routing);
        let incoming = getConfigVersion(routing);
        let current = this.routingVersion();
        if (incoming >= current) return;
        throw new Error(`Routing config write refused - the version is not newer. Refusing to write ${ROUTING_FILE} to store ${this.folder}: its version (${incoming}) is older than the one this store is running (${current}). Increment the version to update it.`);
    }

    // A fresh (unstamped) write must land on the node the config currently points at: the markers tell the client its config is stale, so it re-resolves and retries against the right node instead of us silently accepting data we were never meant to hold.
    private assertFreshWriteTarget(key: string, writeTime: number, route: number): void {
        let timeValid = this.storeConfig.all().filter(x => writeTime >= x.validWindow[0] && writeTime < x.validWindow[1]);
        if (!timeValid.length) {
            logWrongTargetRejection(`Rejecting fresh write of ${JSON.stringify(key)} (store ${this.folder}): writeTime ${writeTime} (${formatDateTimeDetailed(writeTime)}) is outside all our valid windows ${JSON.stringify(this.storeConfig.all().map(x => x.validWindow))} (a switchover moved the write target)`);
            throw new Error(`${STORAGE_WRONG_VALID_WINDOW} Write rejected: write time is outside our valid windows. Cannot write ${JSON.stringify(key)}: its write time ${writeTime} (${formatDateTimeDetailed(writeTime)}) is outside every valid window of store ${JSON.stringify(this.storeName)} (windows: ${JSON.stringify(this.storeConfig.all().map(x => x.validWindow))}, folder ${this.folder}) - a switchover moved the write target. Re-resolve the currently valid source and retry.`);
        }
        if (!timeValid.some(x => routeContains(x.route, route))) {
            logWrongTargetRejection(`Rejecting fresh write of ${JSON.stringify(key)} (store ${this.folder}): route ${route} is outside our routes ${JSON.stringify(timeValid.map(x => x.route || FULL_ROUTE))} at writeTime ${writeTime} (the client's shard config is stale)`);
            throw new Error(`${STORAGE_WRONG_ROUTE} Write rejected: wrong route for this store. Route ${route} (key ${JSON.stringify(key)}, our routes at this time: ${JSON.stringify(timeValid.map(x => x.route || FULL_ROUTE))}, store ${this.folder}). Re-resolve the source for this key and retry.`);
        }
    }

    private async assertMutable(key: string, writeTime: number): Promise<void> {
        if (!this.storeConfig.all().length) return;
        let self = selectEntryAt(this.storeConfig.all(), writeTime, getRoute(key));
        if (!self?.immutable) return;
        if (await this.getInfo({ path: key })) {
            throw new Error(`Write rejected - immutable store and the file already exists. At write time ${writeTime}, ${JSON.stringify(key)} already exists (store ${this.folder})`);
        }
    }

    // See SetConfig.internal: the stamp must land inside SOME window+route this store is configured for (any window, including past ones - synchronization moves old data), so a confused peer can't stuff data onto a store that was never meant to hold it
    private assertInternalWriteAccepted(key: string, writeTime: number, route: number): void {
        if (!this.storeConfig.all().length) return;
        let covered = this.storeConfig.all().some(x => writeTime >= x.validWindow[0] && writeTime < x.validWindow[1] && routeContains(x.route, route));
        if (!covered) {
            throw new Error(`Internal write rejected - outside every configured window/route. Writing ${JSON.stringify(key)}: writeTime ${writeTime} (${formatDateTimeDetailed(writeTime)}) at route ${route} is outside every window/route this store is configured for: ${JSON.stringify(this.storeConfig.all().map(x => ({ validWindow: x.validWindow, route: x.route || FULL_ROUTE })))} (store ${this.folder})`);
        }
    }

    /** Internal (store-to-store) read: purely the local disk, completely short-circuiting the index and holder resolution - the caller is another store, and chasing OUR remote holders while answering it is how infinite get loops between stores form. No window or route checks: if the bytes are on our disk, the caller may have them. Note this reads the disk past any write delay, so a fast write still buffered in memory is invisible here; the caller re-finds it once it flushes. */
    private async getInternal2(config: { path: string; range?: { start: number; end: number }; includeTombstones?: boolean }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        await this.init();
        // includeTombstones forwards to the disk: a flag-caller (a peer store's synchronization) needs to see our deletions, not just our content. A tombstone deleted from disk entirely only lives in our index, so fall back to that.
        let result = await this.getDiskSource().disk.get2(config.path, { range: config.range, includeTombstones: config.includeTombstones });
        if (!result || !result.data) {
            if (config.includeTombstones) {
                let deleted = this.getDeletedEntry(config.path);
                if (deleted) return { data: Buffer.alloc(0), writeTime: deleted.writeTime, size: 0 };
            }
            return undefined;
        }
        return { data: result.data, writeTime: result.writeTime, size: result.size };
    }

    /** Internal (store-to-store) write: the local disk plus our index, with NO downstream fan-out - the pushing store owns propagation, and fanning its pushes back out is how write loops between stores form. Only-take-latest still applies here. */
    private async setInternal(key: string, data: Buffer, config: { lastModified: number }): Promise<void> {
        await this.init();
        assertValidLastModified(config.lastModified);
        if (config.lastModified < await this.currentWriteTime(key)) return;
        if (data.length === 0) {
            // The bytes stay on our disk as deletion history (see writeToSources) - the marked index entry is the whole of the deletion
            this.setIndexDeleted(key, config.lastModified);
            logMutation({ op: "del", folder: this.folder, store: this.storeName, path: key, writeTime: config.lastModified, internal: true });
            return;
        }
        await this.sources[0].source.set(key, data, { lastModified: config.lastModified, forceSetImmutable: true, noChecks: true });
        this.setIndexEntry(key, { writeTime: config.lastModified, size: data.length, sourcesListIndex: this.sourcesListIndexOfSlot(0) });
        logMutation({ op: "set", folder: this.folder, store: this.storeName, path: key, size: data.length, writeTime: config.lastModified, internal: true });
    }

    // The read's bytes came from a remote source, so write them onto our own base source (the local disk), which becomes the entry's new holder - reads only pay the remote fetch once
    private async cacheRead(key: string, result: { data: Buffer; writeTime: number }): Promise<void> {
        await this.sources[0].source.set(key, result.data, { lastModified: result.writeTime, forceSetImmutable: true, noChecks: true });
        this.setIndexEntry(key, { writeTime: result.writeTime, size: result.data.length, sourcesListIndex: this.sourcesListIndexOfSlot(0) });
        // A down-cache pulls the bytes off a source exactly like synchronization does, so it counts (and logs) the same way
        this.noteSyncTransfer("sync get", key, result.data.length);
    }

    // The shared engine of set and del: an empty buffer is exactly a deletion here, which is why the empty-buffer rejection lives in set (the public API), not in this machinery
    private async setOrDelete(key: string, data: Buffer, config: { lastModified?: number }): Promise<void> {
        this.config?.onWriteCounted?.("original", data.length);
        let lastModified = config.lastModified;
        if (lastModified) {
            assertValidLastModified(lastModified);
            // An older write never overwrites a newer one (see IArchives.set)
            if (lastModified < await this.currentWriteTime(key)) return;
        }
        // Fast writes are not handled here: a source that was configured with a write delay buffers them itself (see ArchivesDelayed), so this write lands in memory and returns, exactly as it would have. The index is updated either way, so the write is immediately visible to readers of this store.
        await this.writeToSources(key, data, Math.round(lastModified || Date.now()));
    }

    /** The instant every delayed write must be on its source: the end of our own write window that contains now, minus the flush margin (so the next window's source finds the data on handoff). The LATEST end among covering windows - overlapping windows hand off at the last one. No window contains now (an inert store, or a moment between our windows) -> 0, i.e. nothing may be delayed at all. */
    public writeFlushDeadline(): number {
        // Before updateSources has run there is nothing to hold a write anyway, and nothing may be delayed
        if (!this.sources.length) return 0;
        let now = Date.now();
        let end = 0;
        for (let w of this.sources[0].validWindows) {
            if (w[0] <= now && now < w[1]) end = Math.max(end, w[1]);
        }
        if (!end) return 0;
        return end - WINDOW_END_FLUSH_MARGIN;
    }

    private getWritableSources(config?: { ignoreWindow?: boolean }): number[] {
        let writable: number[] = [];
        for (let i = 0; i < this.sources.length; i++) {
            if (!this.isLive(i)) continue;
            if (!config?.ignoreWindow && !windowsAcceptWrites(this.sources[i].validWindows)) continue;
            writable.push(i);
        }
        return writable;
    }

    // Our own source (the first writable one) plus every route-matching peer. Each source decides for itself how long it holds the write before it hits storage (see ArchivesDelayed) - here they all just get written.
    private async writeToSources(key: string, data: Buffer, writeTime: number): Promise<void> {
        // The routing file is NEVER synchronized between storage nodes: the writer writes it directly to each node, so we store it on our own disk only (no valid-window filter - routing/valid windows can't possibly apply to the file defining them) and never forward it to other sources.
        this.config?.onWriteCounted?.("flushed", data.length);
        let isRouting = key === ROUTING_FILE;
        let writable = this.getWritableSources({ ignoreWindow: isRouting });
        let first = writable.shift();
        if (first === undefined) {
            throw new Error(`No source accepts writes (every source's valid window is in the past), so writes cannot be stored (store ${this.folder})`);
        }
        // Only our own (first) source blocks the write. Downstream sources are written in the background: a down downstream source must not fail or stall writes, and reconciliation re-sends anything they missed once they come back.
        if (data.length === 0) {
            // The bytes STAY on our disk, as deletion history: the index marks the key deleted (keeping its value - see TransactionFile.delete), reads stop finding it, and the retention pass physically removes the oldest history once it outgrows its budget (see StoreSync.enforceHistoryLimit). The marked index entry is the whole of the local deletion.
            this.setIndexDeleted(key, writeTime);
        } else {
            await this.sources[first].source.set(key, data, { lastModified: writeTime, noChecks: true });
            this.setIndexEntry(key, { writeTime, size: data.length, sourcesListIndex: this.sourcesListIndexOfSlot(first) });
        }
        logMutation({ op: data.length === 0 && "del" || "set", folder: this.folder, store: this.storeName, path: key, size: data.length, writeTime });
        if (isRouting) return;
        let route = getRoute(key);
        // Deletions did not consume the first slot (nothing is written anywhere locally), so it receives the propagated deletion like the rest - except slot 0, our own disk, whose bytes ARE the history being kept
        if (data.length === 0 && first !== 0) {
            writable.unshift(first);
        }
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
                logStorageError(`Background write of ${key} to sync source ${this.sources[i].source.getDebugName()} (store ${this.folder}) failed: ${e.stack ?? e}`);
            });
        }
    }

    // Slot 0 is always this store's own folder (see planSources), so the disk is known without searching for it - and it is the unwrapped one, past any write delay
    private getDiskSource(): { disk: ArchivesDisk; sourceIndex: number } {
        return { disk: this.ownDisk, sourceIndex: 0 };
    }

    /** Writes everything still held by a delayed source (see ArchivesDelayed). force also writes what isn't due yet - shutdown cannot leave writes in memory. */
    private async flushDelayedWrites(force?: boolean): Promise<void> {
        for (let { source } of this.sources) {
            let delayed = asDelayed(source);
            if (!delayed) continue;
            await delayed.flush(force);
        }
    }

    // #endregion
}
