/// <reference types="node" />
/// <reference types="node" />
import { IArchives, ArchiveFileInfo, ArchivesSource, ArchivesSyncStatus, ChangesAfterConfig, FindConfig, RemoteConfig, SourceConfig, SyncActivity } from "../IArchives";
import { StoreSync } from "./storeSync";
import { StoreConfig } from "./storeConfig";
export declare const WINDOW_END_FLUSH_MARGIN: number;
export declare const HISTORY_MIN_BYTES: number;
/** The multiple of a store's live bytes its deletion history may grow to. Async so it can later become dynamic and user-configurable; for now it is a constant. */
export declare function getHistoryFactor(): Promise<number>;
/** What we store about a file. Its times are not in here: the index keeps those for every key, deleted ones included (see TransactionFile). */
type IndexValue = {
    size: number;
    sourcesListIndex: number;
};
/** One file we hold, as everything outside the index sees it. */
export type IndexEntry = IndexValue & {
    writeTime: number;
    changedAt: number;
};
export type BlobSourceSpec = {
    identity: string;
    url: string;
    validWindows: [number, number][];
    route?: [number, number];
    noFullSync?: boolean;
    intermediate?: string;
    sourceConfig?: SourceConfig;
    create: () => IArchives;
    applyConfig?: (source: IArchives) => void;
};
export declare class BlobStore {
    folder: string;
    /** The name this store answers to (see CommonConfig.name) - the entries of the routing config that carry it are the ones that configure it, and the rest are its peers. */
    storeName: string;
    private config?;
    stopped: {
        stop: boolean;
    };
    syncStarted: boolean;
    /** Its sources, in config order: slot 0 is always its own disk folder, the rest are the peers it synchronizes with. Filled by updateSources, which is also how they change. The store OWNS them - writes pick among them, reads resolve holders through them - and StoreSync only scans whatever is in here at the time. */
    sources: ArchivesSource[];
    private discardedUploads;
    private nextDiscardedUpload;
    private sourcesList;
    private slotSourcesListIndexes;
    private slotRegistrations;
    private index;
    /** Keeping the index in agreement with the sources: scanning, pulling, pushing, and the maintenance that follows from holding an index (disk-limit eviction, tombstone expiry). It reads and writes this store's index and sources - it does not own them. */
    sync: StoreSync;
    constructor(folder: string, 
    /** The name this store answers to (see CommonConfig.name) - the entries of the routing config that carry it are the ones that configure it, and the rest are its peers. */
    storeName: string, config?: {
        /** Whether a config entry is THIS SERVER (same account, same bucket, our own address). Injected because a store knows nothing about servers - it only needs to tell its own entries apart from its peers'. Absent means nothing is us, which is what a bare store (no server around it) wants. */
        isSelf?: ((source: SourceConfig) => boolean) | undefined;
        /** Builds one of its sources. Injected for the same reason, and because the delay it is created with is this store's policy. */
        createSource?: ((config: {
            sourceConfig?: SourceConfig;
            writeDelay: number;
        }) => IArchives) | undefined;
        /** Hands a running source a changed config, so an endpoint we already talk to is never rebuilt just because a flag moved. */
        applySource?: ((source: IArchives, sourceConfig: SourceConfig | undefined, writeDelay: number) => void) | undefined;
        onIndexChanged?: ((key: string) => void) | undefined;
        /** Called every time this store applies a routing config to itself (startup, an operator's write, a peer's copy arriving) - the store is the one that knows when a config landed, and the server arms window-boundary scans from it. */
        onRoutingApplied?: ((routing: RemoteConfig) => void) | undefined;
        /** Asks the client whose request created this store what routing config it intended for our name. Only used when init finds NO configuration in our folder: a store only ever exists because a config names it, so the requester has that config - asking for it lazily is the same information as passing the config on every call, without the per-call kilobytes. */
        requestRoutingConfig?: (() => Promise<RemoteConfig | undefined>) | undefined;
        onWriteCounted?: ((kind: "original" | "flushed", bytes: number) => void) | undefined;
        /** A synchronization transfer: "sync get" is bytes pulled off a source (the backblaze download bill), "sync set" is bytes pushed to one. Injected because sync traffic never passes through the API controller, so nothing else can count it. */
        onSyncTransfer?: ((operation: "sync get" | "sync set", path: string, bytes: number) => void) | undefined;
        resolveSourceUrl?: ((url: string) => IArchives) | undefined;
    } | undefined);
    /** This store's folder, unwrapped: the same bytes slot 0 serves, but reached without its write delay. Used for the two things that cannot go through a buffered source - reading our own routing config before we have any sources, and streaming a large upload that must not sit in memory. */
    private ownDisk;
    /** What this store is configured to be. It owns this: the routing config is a file IN the store, so the store reads it, applies it to itself, and re-applies it whenever the file changes - by our own write, or by a peer's copy arriving through synchronization. */
    storeConfig: StoreConfig;
    private appliedRoutingVersion;
    private appliedRouting;
    init: {
        (): Promise<void>;
        reset(): void;
        set(newValue: Promise<void>): void;
    };
    /**
     * Re-reads the routing config out of this store and applies it to itself. Called at startup and
     * whenever that file changes here - which is the ONE mechanism: a config written by an operator
     * and a config pulled off a peer are the same event, a write of that path into this store.
     *
     * A store with no routing config configures itself as its own disk, valid always, for the whole
     * key space. That is a complete, working store - it just has nobody to synchronize with - and it
     * is what lets a store exist before it has ever heard of a configuration.
     */
    applyRoutingConfig(): Promise<void>;
    private readRoutingConfig;
    /** The version of the routing config this store is running, so a copy found on a peer is only taken when it is genuinely newer. -1 means it has none. */
    routingVersion(): number;
    private routingApplies;
    reapplyRoutingConfig(): void;
    private planSources;
    dispose(): Promise<void>;
    get2(config: {
        path: string;
        range?: {
            start: number;
            end: number;
        };
        internal?: boolean;
        includeTombstones?: boolean;
        includeMarked?: boolean;
    }): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
    } | undefined>;
    set(config: {
        path: string;
        data: Buffer;
        lastModified?: number;
        forceSetImmutable?: boolean;
        internal?: boolean;
        undelete?: boolean;
    }): Promise<void>;
    del(config: {
        path: string;
        lastModified?: number;
        internal?: boolean;
    }): Promise<void>;
    /** A node-side move: the bytes never travel through the client. Deliberately just get2 + set + del rather than a disk rename, so the destination write passes EVERY rule a set passes (windows, routes, immutability, only-take-latest, index, fan-out to peers) and the deletion propagates as a normal tombstone - a rename would bypass all of it. The set stamps fresh, so the moved file beats any tombstone at its new path. */
    move(config: {
        fromPath: string;
        toPath: string;
    }): Promise<void>;
    getInfo(config: {
        path: string;
        includeTombstones?: boolean;
    }): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo(config: FindConfig & {
        prefix: string;
    }): Promise<ArchiveFileInfo[]>;
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    getSyncStatus(): Promise<ArchivesSyncStatus>;
    /** The index's totals plus any in-progress background synchronization. */
    getSyncProgress(): {
        index: {
            fileCount: number;
            byteCount: number;
        };
        marked: {
            fileCount: number;
            byteCount: number;
            oldestDeleteTime?: number;
        };
        sources: {
            debugName: string;
            fileCount: number;
            byteCount: number;
        }[];
        readerDiskLimit?: number;
        syncing: SyncActivity[];
    };
    /** getSyncProgress's totals, but loading the index first, so they are never the zeroes of a store nothing has touched yet. */
    computeIndexTotals(): Promise<{
        fileCount: number;
        byteCount: number;
        sources: {
            debugName: string;
            fileCount: number;
            byteCount: number;
        }[];
    }>;
    private namedIndexTotals;
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
    updateSources(specs: BlobSourceSpec[]): void;
    /** Rescans our own disk's metadata into the index - used around valid window handoffs, where another process wrote files to the shared folder that our index hasn't seen. */
    rescanBase(): Promise<void>;
    /** A boundary scan of the node that owned (part of) our route in the valid window before ours, when that node is different storage (a disk rescan can't see its writes). */
    boundaryScanRemote(source: IArchives, config: {
        since: number;
        route?: [number, number];
    }): Promise<void>;
    startLargeUpload(config?: {
        path?: string;
        lastModified?: number;
        forceSetImmutable?: boolean;
        noChecks?: boolean;
        internal?: boolean;
    }): Promise<string>;
    appendLargeUpload(config: {
        id: string;
        data: Buffer;
        offset?: number;
    }): Promise<void>;
    finishLargeUpload(config: {
        id: string;
        path: string;
        lastModified?: number;
        forceSetImmutable?: boolean;
        noChecks?: boolean;
        internal?: boolean;
    }): Promise<void>;
    cancelLargeUpload(config: {
        id: string;
    }): Promise<void>;
    /** Bytes of read cache the disk may hold; see CommonConfig.readerDiskLimit (StoreSync enforces it). Read from the config in effect, so raising or removing the limit takes effect on the next eviction pass. */
    get readerDiskLimit(): number | undefined;
    /** The write time a new write has to beat, or 0 when we have never heard of the key. Counts DELETIONS too: a write older than the deletion that removed it must not bring it back. The index is authoritative even for a write still buffered in a delayed source, since the entry is recorded when the write is accepted rather than when it reaches storage. */
    currentWriteTime(key: string): number;
    private isLive;
    registerSlot(slot: number): Promise<void>;
    /** The persistent sourcesListIndex of a slot, or undefined when the slot never got that far (a source removed before its registration resolved). */
    slotSourcesListIndex(slot: number): number | undefined;
    sourcesListIndexOfSlot(slot: number): number;
    slotForSourcesListIndex(sourcesListIndex: number): number | undefined;
    getEntryHolder(entry: IndexEntry): Promise<IArchives | undefined>;
    private loadIndex;
    /** A file we hold. A deleted one is not one: it is a tombstone, and only getDeletedEntry knows about it. */
    getIndexEntry(key: string): IndexEntry | undefined;
    /** When a key was deleted, if it was. A deletion is an absence with a time attached - that time is what makes it propagate and what expires it. */
    getDeletedEntry(key: string): {
        writeTime: number;
        changedAt: number;
    } | undefined;
    /** Every file we hold, for the passes that walk them all (listings, scans, reconciliation, eviction). Deletions are not in here - see deletedEntries. Live: deleting entries while iterating is expected here, and safe. */
    indexEntries(): IterableIterator<[string, IndexEntry]>;
    /** Every deletion we know of. A much smaller walk than the files, which is what makes expiring them cheap. */
    deletedEntries(): IterableIterator<[string, {
        writeTime: number;
        changedAt: number;
    }]>;
    /** A file MARKED for deletion: its kept index value plus when it was deleted. Undefined when the key is live, never existed, or its history was already dropped. */
    getMarkedEntry(key: string): (IndexEntry & {
        deleteTime: number;
    }) | undefined;
    /** Every file marked for deletion - the deletion history, walked by retention and by includeMarked listings. */
    markedEntries(): IterableIterator<[string, IndexEntry & {
        deleteTime: number;
    }]>;
    /** The deletion history's totals: how many marked files, their bytes, and the delete time of the OLDEST one - which is how far back the history reaches. */
    markedTotals(): {
        fileCount: number;
        byteCount: number;
        oldestDeleteTime?: number;
    };
    /** Physically removes a marked file's bytes from our disk and drops its kept value, leaving a plain tombstone that ages out normally - retention calling time on the oldest history. */
    dropMarkedHistory(key: string): Promise<void>;
    /** See SetConfig.undelete: flips a marked deletion back to live (fresh write time, so the restore outranks the deletion everywhere it propagated) - the bytes never left the disk, so reads just work again. Internal restores are a peer's propagation and tolerate having nothing to restore (this node may never have held the file); a caller's restore throws instead. */
    private undeleteKey;
    /** How many files we hold, deletions excluded. */
    indexSize(): number;
    /** Totals over the files we hold, broken down by the slot holding each (entries can name a source that is no longer configured, which counts towards the total but no slot). */
    indexTotals(): {
        fileCount: number;
        byteCount: number;
        slots: {
            fileCount: number;
            byteCount: number;
        }[];
    };
    /** Records a file, as of its write time. Returns false, having changed nothing, when we already know something at least as new - the index cannot be made to go backwards, whichever path the write came in by. */
    setIndexEntry(key: string, entry: {
        writeTime: number;
        size: number;
        sourcesListIndex: number;
    }): boolean;
    /** Records a DELETION, as of its time: the key stops existing here, and the tombstone is what makes that fact propagate and reconcile like any other write. Same ordering rule as setIndexEntry. */
    setIndexDeleted(key: string, writeTime: number): boolean;
    /** Forgets a key entirely, tombstone included. NOT a deletion: it says nothing happened to the file, only that we no longer know anything about it - for an entry whose holder turned out not to have it, and for a tombstone old enough that everyone has heard. */
    purgeIndexEntry(key: string): void;
    /** Counts a synchronization transfer in the server's access statistics (see getStore's wiring): "sync get" for bytes pulled off a source, "sync set" for bytes pushed to one. */
    noteSyncTransfer(operation: "sync get" | "sync set", path: string, bytes: number): void;
    /**
     * Every write, however it is stamped, has to be one we are actually meant to hold - because the
     * alternative is not a smaller problem, it is a silent one. A write that lands on a store that
     * does not serve its route (or on a server that is not in the bucket's config at all) goes into a
     * folder nothing scans and no peer reconciles: it succeeds, and then it is gone. The markers make
     * the client re-read the routing config and retry, which is exactly the right outcome when the
     * reason it aimed here is that its config was stale.
     */
    private assertWriteTarget;
    /** Exactly why this store has no configuration entries - which of the three possible reasons it is, with the values that decided it, because "not configured" alone is undiagnosable. */
    private unconfiguredDetail;
    /**
     * Whether a routing config may be written here. Two rules, and this is the one place either is
     * applied - a config only ever enters the system through a write, so a config that got in is a
     * config that passed, and reading one back never judges it again.
     *
     * The config has to be valid as a whole (see assertValidRemoteConfig), and it has to outrank what
     * we are running: the same version means the same config, so re-writing it is harmless, but a
     * lower one is an older config arriving late and must never undo a newer one.
     */
    private assertRoutingConfigWritable;
    private assertFreshWriteTarget;
    private assertMutable;
    private assertInternalWriteAccepted;
    /** Internal (store-to-store) read: never goes to OTHER sources - the caller is another store, and chasing OUR remote holders while answering it is how infinite get loops between stores form - but the INDEX still gates, because it is the source of truth: a marked deletion keeps its bytes on disk as history (see writeToSources), so the disk alone would happily serve a DELETED file as live. Index says live -> the disk provides the bytes (past any write delay, so a fast write still buffered in memory is invisible here; the caller re-finds it once it flushes). Index says deleted -> the tombstone is the answer, never the disk. No window or route checks. */
    private getInternal2;
    /** Internal (store-to-store) write: the local disk plus our index, with NO downstream fan-out - the pushing store owns propagation, and fanning its pushes back out is how write loops between stores form. Only-take-latest still applies here. */
    private setInternal;
    private cacheRead;
    private setOrDelete;
    /** The instant every delayed write must be on its source: the end of our own write window that contains now, minus the flush margin (so the next window's source finds the data on handoff). The LATEST end among covering windows - overlapping windows hand off at the last one. No window contains now (an inert store, or a moment between our windows) -> 0, i.e. nothing may be delayed at all. */
    writeFlushDeadline(): number;
    private getWritableSources;
    private writeToSources;
    private getDiskSource;
    /** Writes everything still held by a delayed source (see ArchivesDelayed). force also writes what isn't due yet - shutdown cannot leave writes in memory. */
    private flushDelayedWrites;
}
export {};
