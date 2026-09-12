/// <reference types="node" />
/// <reference types="node" />
export declare const MAX_LAST_MODIFIED_FUTURE: number;
export declare const IMMUTABLE_CACHE_TIME: number;
export declare function assertValidLastModified(lastModified: number): void;
/** Every file-addressed operation checks this at its entry point, so an empty name fails right
    where it was passed - with the caller in the stack - instead of surfacing as a baffling backend
    rejection after the retry loops are done with it. */
export declare function validateFileName(fileName: string, operation: string): void;
export type RemoteConfig = {
    version?: number;
    sources: RemoteConfigBase[];
};
/**
    string arguments will be a url, looking like:
        https://storage2.vidgridweb.com:4445/file/exampleaccount/examplebucket/storage/storagerouting.json
        https://f002.backblazeb2.com/file/querysubtest-com-public-immutable/storage/storagerouting.json
        - These map to { url }, with the type inferred from the url
        - Hosted urls are /file/<account>/<bucketName>/..., backblaze urls are /file/<bucketName>/...

    NOTE: If we do not have right access to these, then it becomes a read-only IArchives, where we solely read using the url form (which might throw due to not having access as well). UNLESS Our configuration explicitly has public: false, in which case, we don't even hit the URL and we throw on access.

    NOTE: If we're in the browser, we should allow downloading the files via the URL form (if it's a public bucket), however, we won't allow writing, because their servers do not allow secure browser writes.
*/
export type RemoteConfigBase = string | SourceConfig;
/** One configured source in a routing config: a hosted (our storage server) or backblaze entry. Requests carry the exact SourceConfig they selected, and the server matches it against its own entries to pick the backing store. */
export type SourceConfig = HostedConfig | BackblazeConfig;
export type CommonConfig = {
    /**
     * The storage this entry names, as opposed to the rules for using it. Every entry with the same
     * name (for the same account and bucket) IS the same storage: one folder on the server, one
     * store, one index - however many entries there are and whatever their windows and routes say.
     * Everything about WHEN and WHICH KEYS (validWindow, route) is policy layered on top of it, and
     * changing that policy never moves data.
     *
     * Letters, numbers, underscore, dash and periods, up to 64 characters - so a host or a version
     * can be used as-is. It is the folder name, so it must stay unique and must never be reused for
     * different storage:
     * pointing two unrelated entries at one name merges their data, and re-using a retired name
     * hands the new entry the retired one's files. Deciding that is the developer's job - the server
     * only ever does what the name says.
     */
    name: string;
    /** By default a server hosting this bucket eagerly copies this source's full contents onto its own disk (on top of the lazy read-through caching). Set this to be a front end for a very large database without copying the full database - reads still down-cache individual files on demand. */
    noFullSync?: boolean;
    /** Bytes of read-cache this server's disk may hold; least-recently-used files are deleted from disk to stay under it (only ever when another source verifiably holds the file - the only copy is never deleted). Requires noFullSync (a full copy can't be bounded). */
    readerDiskLimit?: number;
    /** The write times ([startMs, endMs]) this source is valid for (see ArchivesSource.validWindow for the synchronization semantics). Required on object configs: configuration changes must be SCHEDULED (a new source becomes valid at a future time while the old one's window ends), not flipped instantly. Plain URL-string sources default to FULL_VALID_WINDOW - once you're writing object configs, you're doing something complicated enough to think about when things change. */
    validWindow: [number, number];
    /** Sharding: the fraction of the key space this source handles, as [start, end) over [0, 1) (keys are routed by getRoute in remoteConfig.ts). Defaults to FULL_ROUTE (unsharded). At every point in time the sources' routes must fully cover [0, 1), or some keys could never be read. */
    route?: [number, number];
    /** Set on entries injected into the in-memory config by an overlay (a deploy switchover's alternate-port window). Never written to disk: resolveIntermediateSources strips these and rejoins the windows around them, which is also how a client tells whether an update is a real configuration change or just an overlay. The VALUE is the url of the source this intermediate was split out of (its alternate-port view) - so a request naming the intermediate still resolves to the ORIGINAL source, even after the intermediate rejoins and the entry is gone. */
    intermediate?: string;
};
export type HostedConfig = CommonConfig & {
    type: "remote";
    url: string;
    public?: boolean;
    fast?: boolean;
    writeDelay?: number;
    immutable?: boolean;
};
export type BackblazeConfig = CommonConfig & {
    type: "backblaze";
    url: string;
    public?: boolean;
    immutable?: boolean;
    allowedOrigins?: string[];
};
export declare const FULL_VALID_WINDOW: [number, number];
export type GetConfig = {
    range?: {
        start: number;
        end: number;
    };
    /** Read ONLY from the primary source - the one writes would target - instead of falling back across the redundant sources. Use this when you want your reads and writes to be somewhat atomic: there will still be issues with the round trip, but without it you could talk to a completely different node and get a much older value. Most reads aren't followed by a write though, so for most cases it's better to get a value than to have to wait (or even throw) when the primary node is not available. */
    noFallbacks?: boolean;
    /** Store-to-store call: the serving node never consults its OTHER sources - chasing its own remote holders while answering another store is how infinite get loops between stores form (A asks B, B's index points back at A, ...). That is the flag's ENTIRE meaning: no fallbacks, nothing else. The read is otherwise fully correct - the node's index still gates it (a key its index says is deleted answers as deleted, never as the history bytes still sitting on its disk). No window or route checks on reads. */
    internal?: boolean;
    /** Also return size-0 results (tombstones - an empty file IS a missing file) instead of treating them as absent. Off by default, matching getInfo's flag of the same name. Synchronization passes this so a DELETED file (with its write time) is distinguishable from a file that never existed. */
    includeTombstones?: boolean;
    /** Reads files that are MARKED for deletion (deleted, but with their bytes still in the deletion history - see SetConfig.undelete for restoring them). The actual content comes back, unlike includeTombstones, which only reports that a deletion happened. */
    includeMarked?: boolean;
    /** Read from EXACTLY this source - its config url, as ArchivesChain.getFileSources lists them - with no fallback to any other. For comparing the copies different sources hold (combine with internal to read only that server's own disk, skipping its holder resolution). Multi-source archives only; throws when no configured source has the url. */
    sourceUrl?: string;
    /** How many extra times the WHOLE operation is retried after every source in a pass failed - any error counts (the wrong-window/route markers still get their config re-resolve first). Only applies to fallback dispatch (multi-source, not noFallbacks), where it defaults to 3; the noFallbacks/write-node path already retries on its own deadline. Multi-part uploads additionally retry per part regardless of this. */
    retries?: number;
};
export type FindConfig = {
    shallow?: boolean;
    type?: "files" | "folders";
    /** Also list files MARKED for deletion (see GetConfig.includeMarked). */
    includeMarked?: boolean;
    /** Listings normally come ONLY from the authoritative sources (the same nodes writes go to - read-your-writes). With fallbacks, a failing shard's routes are covered by the next source holding them (e.g. a wide read replica) instead of the call failing - high availability at the cost of possibly missing just-written data. Single-source archives ignore the flag. */
    fallbacks?: boolean;
    /** Store-to-store listing: only entries whose bytes the node ITSELF holds - never entries its index redirects to its own other sources. A peer reads with GetConfig.internal (which never chases those redirects), so listing a redirect would just make the peer flag the file missing, purge it, re-list it, and loop forever; the peer hears about such files from the source actually holding them instead. */
    internal?: boolean;
};
export type DelConfig = {
    /** Stamps the deletion (its tombstone) with this write time instead of now. Synchronization passes the ORIGINAL deletion time, so deletion ordering survives propagation exactly like any other write's ordering. */
    lastModified?: number;
    /** See SetConfig.internal. */
    internal?: boolean;
    /** See SetConfig.noChecks. */
    noChecks?: boolean;
    /** See SetConfig.fallbacks. */
    fallbacks?: boolean;
    /** See GetConfig.retries. */
    retries?: number;
};
export type GetInfoConfig = {
    /** Also report size-0 entries (tombstones - an empty file IS a missing file). Off by default, so a deleted key reports undefined, matching get. Synchronization-style callers pass this when they need a deletion's write time (e.g. to compare it against a write they are about to make). */
    includeTombstones?: boolean;
    /** See GetConfig.noFallbacks: answer ONLY from the primary source (the one writes would target) instead of falling back across the redundant sources. */
    noFallbacks?: boolean;
    /** See GetConfig.retries. */
    retries?: number;
    /** See GetConfig.sourceUrl: answer from EXACTLY this source. */
    sourceUrl?: string;
};
export type ChangesAfterConfig = {
    time: number;
    /** Only keys routing into one of these [start, end) ranges. Only scanning passes this - it lets a store syncing a partial shard ask for just its slice. */
    routes?: [number, number][];
    /** See FindConfig.internal - the change feed is a listing too, and redirect entries fail a peer's internal reads the same way. Deletions are always reported (they are index-only, there are no bytes to hold). */
    internal?: boolean;
};
export type SetConfig = {
    /** The write time to stamp (see IArchives.set). ROUNDED to whole milliseconds by every implementation - the disk can't store fractional milliseconds anyway (utimes round-trips whole ms), so a fractional stamp could never be reproduced by propagation and would compare "newer" than its own copies forever. Rounded rather than floored because utimes goes through a seconds double and can read back a hair below the stamped millisecond (see ArchivesDisk.get2). */
    lastModified?: number;
    /** Makes the write acceptable on immutable targets: an existing path is simply kept (immutability wins - nothing is overwritten) instead of the write throwing. Requires lastModified. Synchronization MUST pass this on every push - a plain set throws on immutable targets, which would abort reconciliation whenever one source in a chain is immutable. */
    forceSetImmutable?: boolean;
    /** Skips REDUNDANT target-side safety reads around the write (backblaze: the post-upload existence poll). It does NOT skip checks that are the target's only ordering guard: backblaze's pre-write comparison stays, because b2 has no server of ours enforcing only-take-the-latest - without it a stale push lands over a newer value or tombstone and b2's self-stamped upload time launders it into the newest copy in the system (global resurrection). Hosted targets re-check server-side, so their client-side shortcuts are safe. */
    noChecks?: boolean;
    /** Store-to-store push: the receiving node writes purely to its own disk and index, with NO downstream fan-out (the pushing store owns propagation - fanning its pushes back out is how write loops between stores form). Window and route ARE still checked: the stamp must fall inside one of the receiver's configured windows and routes, so a confused peer cannot stuff data onto a node that was never meant to hold it. Requires lastModified. */
    internal?: boolean;
    /** Writes normally go ONLY to the write node (the first current-window source covering the key), retrying it even while it is down - consistent, but unavailable when that node is. With fallbacks, the write node is still tried first, but on failure the write lands on the next current-window source covering the key (synchronization moves it to the write node later) - availability at the cost of reads possibly missing the write until it propagates. Single-source archives ignore the flag. */
    fallbacks?: boolean;
    /** See GetConfig.retries. */
    retries?: number;
    /** The set is not a write at all: it RESTORES a file marked for deletion, flipping its index entry back to live (with a fresh write time, so the restore outranks the deletion everywhere it propagated) - the bytes never left the disk, so reads just work again. The data buffer is ignored (a 1-byte placeholder satisfies the empty-buffer rule); use IArchives.undelete rather than passing this yourself. Throws when the key has no marked deletion to restore (its history was dropped, or it was never deleted). */
    undelete?: boolean;
};
/** setLargeFile's config: a SetConfig (it IS a set - the same immutability, ordering, internal, and fallbacks rules apply) plus the stream carrying the bytes. */
export type SetLargeFileConfig = SetConfig & {
    path: string;
    getNextData(): Promise<Buffer | undefined>;
    /** Rewinds the stream to its first byte. Without it the write gets exactly ONE attempt: a retry (a fallback source, or the write node coming back) would upload whatever is left of an already-consumed stream as if it were the whole file. Callers holding the data (a buffer, or a source they can re-read) always pass it - a large set with fallbacks is only as available as this. */
    restartStream?(): Promise<void> | void;
};
export type ArchiveFileInfo = {
    path: string;
    createTime: number;
    size: number;
};
export type SyncActivity = {
    type: "metadataScan" | "fullSync";
    sourceDebugName: string;
    startTime: number;
    doneFiles?: number;
    totalFiles?: number;
    doneBytes?: number;
    totalBytes?: number;
};
export type ArchivesConfig = {
    supportsChangesAfter?: boolean;
    remoteConfig?: RemoteConfig;
    index?: {
        fileCount: number;
        byteCount: number;
    };
    /** Files MARKED for deletion (deleted, bytes still kept as history - see SetConfig.undelete): how many, how big, and the delete time of the oldest one - which is how far back the deletion history reaches. */
    markedIndex?: {
        fileCount: number;
        byteCount: number;
        oldestDeleteTime?: number;
    };
    indexSources?: {
        debugName: string;
        fileCount: number;
        byteCount: number;
    }[];
    readerDiskLimit?: number;
    syncing?: SyncActivity[];
};
export type ArchivesSource = {
    source: IArchives;
    /** The persistent identity of the endpoint: its routing URL (hosted/backblaze), or the disk folder path for the base disk source. The store persists this (via its append-only sources list) as IndexEntry.sourcesListIndex, so it must mean the same endpoint forever. */
    url: string;
    validWindows: [number, number][];
    route?: [number, number];
    noFullSync?: boolean;
    intermediate?: string;
    sourceConfig?: SourceConfig;
    identity?: string;
};
export declare const STORAGE_WRONG_VALID_WINDOW = "REMOTE_STORAGE_WRONG_VALID_WINDOW_a7c1f04e";
export declare const STORAGE_WRONG_ROUTE = "REMOTE_STORAGE_WRONG_ROUTE_c94d2e17";
export declare const STORAGE_NOT_CONFIGURED = "REMOTE_STORAGE_NOT_CONFIGURED_e51b7d92";
export declare const FULL_ROUTE: [number, number];
export declare const VARIABLE_SHARD = "VARIABLE_SHARD_f0234jfah08fgyhfgyssdds83nmp";
export declare function windowAcceptsWrites(validWindow: [number, number] | undefined): boolean;
export declare function windowsAcceptWrites(validWindows: [number, number][]): boolean;
export declare const LARGE_SET_THRESHOLD: number;
/** The setLargeFile stream over an in-memory buffer, in LARGE_SET_THRESHOLD slices - how set transparently becomes setLargeFile for large buffers. Spread into the config: it provides both getNextData and restartStream (the buffer is still held, so a retry costs nothing). */
export declare function bufferChunkStream(data: Buffer): {
    getNextData(): Promise<Buffer | undefined>;
    restartStream(): void;
};
export { copyArchiveFile } from "./archiveHelpers";
/** move's config. There is deliberately no lastModified: the destination is ALWAYS stamped fresh (see IArchives.move) - a move is a new write at the new path, and a preserved old stamp is how a moved file loses to a stale tombstone there and vanishes. */
export type MoveFileConfig = {
    fromPath: string;
    toPath: string;
};
export type ArchivesSyncSourceStatus = {
    debugName: string;
    validWindows: [number, number][];
    route?: [number, number];
    noFullSync?: boolean;
    supportsChangesAfter: boolean;
    initialScanComplete: boolean;
    scannedCount: number;
};
export type ArchivesSyncStatus = {
    allScansComplete: boolean;
    indexSize: number;
    sources: ArchivesSyncSourceStatus[];
};
export interface IArchives {
    getDebugName(): string;
    /** Whether writes would be accepted (credentials exist, the account trusts this machine, etc). Checked without writing anything. */
    hasWriteAccess(): Promise<boolean>;
    /**
     * Reads automatically fall back across the redundant sources unless config.noFallbacks is set.
     * A fallback copy can lag the write target, so a caller reading state in order to mutate it
     * (e.g. x++), where acting on previous state would cause big issues, should pass noFallbacks -
     * and try/catch the read, handling the catch case (a down primary is retried for a while, then
     * throws instead of degrading to a stale copy).
     */
    get(fileName: string, config?: GetConfig): Promise<Buffer | undefined>;
    /** See get for the fallback semantics (and when to pass noFallbacks). url is the config URL of the source that answered - the authority the data (or the "does not exist") came from. Multi-source implementations (ArchivesChain) ALWAYS return an object: when the value doesn't exist there is still a server saying it doesn't exist, so they return { url } alone rather than undefined. Single-source backends return undefined for absent (they ARE the authority). */
    get2(fileName: string, config?: GetConfig): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
        url?: string;
    } | {
        data?: undefined;
        writeTime?: undefined;
        size?: undefined;
        url: string;
    } | undefined>;
    /**
     * lastModified stamps the write with that last-write time instead of now. If it is OLDER than
     * the file's current last-write time the write no-ops (so delayed / synchronized writes can
     * never clobber newer data). Times more than 15 minutes in the future are rejected.
     *
     * Returns the full key actually written - identical to fileName, EXCEPT for keys containing
     * VARIABLE_SHARD, where the shard value is materialized into the key (picked by shard latency,
     * see ArchivesChain) and the caller needs the returned key to ever read the value back.
     */
    /**
     * THROWS on an empty buffer: an empty file IS a deletion in this system (the tombstone), so a
     * set-empty would read back as "the file is gone" - which is just asking for problems. If you
     * want the file deleted, call del; deletions take their own path.
     */
    set(fileName: string, data: Buffer, config?: SetConfig): Promise<string>;
    del(fileName: string, config?: DelConfig): Promise<void>;
    /** Moves a file to a new path within THIS archives, backend-side where the backend can (backblaze copies server-side, disk renames, the storage server relocates node-side) - the bytes never travel through the caller. The destination is stamped with a FRESH write time, even when the underlying operation (a rename) would preserve the old one, so the moved file cannot immediately lose to something newer sitting at its new path (e.g. the tombstone of an earlier deletion there); the source is then deleted, exactly like del. THROWS when the source file does not exist. Optional - callers go through moveArchiveFile (archiveHelpers.ts), which falls back to copy + confirm + delete. */
    move?(config: MoveFileConfig): Promise<void>;
    /** Restores a deleted file whose bytes are still in the deletion history (see SetConfig.undelete, which this rides on). Only index-backed stores keep a deletion history, so only they support this. THROWS when there is nothing to restore. */
    undelete?(fileName: string): Promise<void>;
    /** Streams a file too large to hold in memory. getNextData returns undefined when done. This only needs to be called when you CANNOT materialize the entire file in memory - if you can, just call set: above LARGE_SET_THRESHOLD it streams through setLargeFile internally, keeping the client responsive and not overwhelming the server. The rest of the config is a plain SetConfig and means exactly what it means on set (that is what makes a large set behave like a small one instead of quietly losing immutability, ordering, internal, or fallbacks semantics as the file crosses the threshold); backends that stamp their own times (backblaze) accept and ignore lastModified. THROWS when the stream produces no data at all - same rule as set: an empty file IS a deletion and would read back as missing. */
    setLargeFile(config: SetLargeFileConfig): Promise<void>;
    /** writeTime is the last-write time — see ArchiveFileInfo.createTime, which is the same value. url as in get2. Size-0 entries (tombstones) report undefined unless config.includeTombstones. */
    getInfo(fileName: string, config?: GetInfoConfig): Promise<{
        writeTime: number;
        size: number;
        url?: string;
    } | undefined>;
    /**
     * Empty (size-0) files are NEVER returned by index-backed stores (BlobStore, and therefore the
     * chain): an empty file IS a missing file - the tombstone of a deletion. If you want a marker
     * file that shows up in listings, add some content to it. Raw sources (disk, backblaze) DO list
     * their empty files - that is how scans learn of deletions - but nothing built on the index
     * ever surfaces them.
     */
    find(prefix: string, config?: FindConfig): Promise<string[]>;
    /** See find for the empty-file (tombstone) rule. */
    findInfo(prefix: string, config?: FindConfig): Promise<ArchiveFileInfo[]>;
    /** Only works for public buckets (private buckets are API-access only). */
    getURL(path: string): Promise<string>;
    /** The bucket's configuration, which tells whether the optional functions are supported. */
    getConfig(): Promise<ArchivesConfig>;
    /**
     * All files changed after config.time, optionally restricted to keys routing into one of
     * config.routes (used by scanning, so partially-overlapping shards only receive their slice).
     * When getConfig().supportsChangesAfter, this is backed by an index (fast, and deletions ARE
     * reported, as size-0 tombstone entries). Every other backend emulates it: a full findInfo
     * listing filtered in memory - correct, but no cheaper than the listing itself.
     */
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    /** Synchronization introspection, for backends that synchronize from sources (see BlobStore). */
    getSyncStatus?(): Promise<ArchivesSyncStatus>;
}
