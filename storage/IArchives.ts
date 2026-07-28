// The important operations of an archive bucket (extracted from ArchivesBackblaze), so other backends (e.g. our own remote storage server) can be used interchangeably.

// A write may not be stamped more than this far in the future, or clock skew between machines would let a bad timestamp block writes for a long time.
export const MAX_LAST_MODIFIED_FUTURE = 15 * 60 * 1000;

// How long browsers may cache files from immutable buckets (the Cache-Control max-age), shared by every hosting path (backblaze bucket settings and our own storage server's HTTP route)
export const IMMUTABLE_CACHE_TIME = 86400 * 1000;
export function assertValidLastModified(lastModified: number): void {
    let max = Date.now() + MAX_LAST_MODIFIED_FUTURE;
    if (lastModified > max) {
        throw new Error(`lastModified is too far in the future: ${lastModified} > ${max} (now + 15 minutes)`);
    }
}


export type RemoteConfig = {
    // NOTE: Version is used when updating the configuration. The newer version is always taken. A missing version counts as version -1.
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

    // Ex: https://99-250-124-91.querysubtest.com:5233/file/root/uniquebucketname/storage/storagerouting.json
    // NOTE: The account and bucket name are obtained from the URL.
    url: string;

    // NOTE: Authentication is handled by cert.ts, via having your machine trusted to access this account. 

    public?: boolean;
    // Fast mode: the server acknowledges writes once they are in memory, flushing to disk after writeDelay (default 5 minutes) and coalescing writes to the same file. A server crash loses writes that haven't flushed yet.
    fast?: boolean;
    writeDelay?: number;
    // Writes to paths that already exist are disallowed (deletes still work).
    immutable?: boolean;
};

export type BackblazeConfig = CommonConfig & {
    type: "backblaze";
    // Ex: https://f002.backblazeb2.com/file/querysubtest-com-public-immutable/storage/storagerouting.json
    // NOTE: The bucket name is obtained from the URL.
    url: string;
    // Public buckets are served over plain HTTPS GETs (getURL). Private buckets are API-access only.
    public?: boolean;
    // NOTE: This isn't enforced on the backblaze level, so this is just a client-side guarantee. This can change how we cache files.
    //  - Backblaze does support immutability. However, apparently, once we enable it on a bucket, we can't disable it, which is really bad, as it means if our code could ever enable it and we accidentally enable it on an important bucket, we essentially just bricked that bucket. So we should never write any code that ever tries to use backblaze to make things immutable. 
    immutable?: boolean;
    // CORS origins allowed to consume the bucket's files in a browser. Not a security boundary (access is gated by the API key / signed URLs, neither of which rides in cookies) - it only controls which sites' in-page JavaScript can read responses. Defaults to any HTTPS origin.
    allowedOrigins?: string[];

    // NOTE: We will access the api key from getSecret, see backblaze.ts for the specific keys.
};


export const FULL_VALID_WINDOW: [number, number] = [0, Number.MAX_SAFE_INTEGER];




export type GetConfig = {
    range?: { start: number; end: number };
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

// createTime is a misnomer kept for compatibility — it is really the LAST-WRITE time, same as getInfo's writeTime. Neither Backblaze nor our remote storage tracks a distinct creation date: each write stamps a fresh timestamp on the current version, so both fields are just "when the bytes served by get() were most recently written". Always WHOLE milliseconds: write times are rounded at every producer (see SetConfig.lastModified).
export type ArchiveFileInfo = { path: string; createTime: number; size: number };

// An in-progress background synchronization task (see ArchivesConfig.syncing)
export type SyncActivity = {
    // A metadata scan is a single listing call, so it has no incremental progress - just that it's running and since when. A full sync knows its exact file/byte progress.
    type: "metadataScan" | "fullSync";
    sourceDebugName: string;
    startTime: number;
    doneFiles?: number;
    totalFiles?: number;
    doneBytes?: number;
    totalBytes?: number;
};

export type ArchivesConfig = {
    // Whether getChangesAfter2 is natively index-backed (fast change polling; every backend still serves it, but the others emulate it with a full listing)
    supportsChangesAfter?: boolean;
    // The bucket's full routing config (ROUTING_FILE). Absent for sources that don't have one (a bare disk source, or a bucket that doesn't exist yet).
    remoteConfig?: RemoteConfig;
    // Live index totals (tombstones excluded), kept up to date in memory on every mutation and recomputed on load - so any drift heals on restart
    index?: { fileCount: number; byteCount: number };
    /** Files MARKED for deletion (deleted, bytes still kept as history - see SetConfig.undelete): how many, how big, and the delete time of the oldest one - which is how far back the deletion history reaches. */
    markedIndex?: { fileCount: number; byteCount: number; oldestDeleteTime?: number };
    // The same totals broken down by which source currently holds each file's bytes (the first entry is the server's own disk)
    indexSources?: { debugName: string; fileCount: number; byteCount: number }[];
    // The server's configured readerDiskLimit, when it runs as a bounded read cache
    readerDiskLimit?: number;
    // Background synchronization currently in progress (empty when idle)
    syncing?: SyncActivity[];
};

// A synchronization source of a BlobStore (which synchronizes an index + local cache from them)
export type ArchivesSource = {
    source: IArchives;
    /** The persistent identity of the endpoint: its routing URL (hosted/backblaze), or the disk folder path for the base disk source. The store persists this (via its append-only sources list) as IndexEntry.sourcesListIndex, so it must mean the same endpoint forever. */
    url: string;
    // From the source's CommonConfig, but ALL of them: the same endpoint (same url+route, ignoring the window) can appear in the routing config under several windows at once - most commonly when a deploy switchover has split one window in two around an intermediate. It is ONE source that knows all its windows, never several sources. The window routes WRITES: the source receives writes while ANY of its windows is still open (see windowsAcceptWrites). Windows do NOT filter scanning: a scan is us asking the source what it already holds, and existing values synchronize regardless of their write times (the same reasoning that lets synchronization ignore the immutable flag).
    validWindows: [number, number][];
    // From the source's CommonConfig (intersected with the owning store's own route): only keys routing into [start, end) are accepted from this source's scans and sent to it in writes/reconciliation. The routing file is exempt - config flows everywhere. Absent = all keys.
    route?: [number, number];
    // From the source's CommonConfig; see there.
    noFullSync?: boolean;
    // From the source's CommonConfig: a deploy switchover's temporary alternate-port entry (the value is the url of the source it was split out of). Once its window is past, the port it points at is gone for good - so it is never scanned then, and scan failures are never retried.
    intermediate?: string;
    // The routing-config entry this source was built from (absent for the base disk source). Its `type` decides fast-write flush timing: type-"remote" downstream sources (our own storage servers) flush quickly (cheap, and we want cross-node redundancy fast), while others (e.g. backblaze) keep the full writeDelay so expensive external writes stay coalesced. The window/route ON this config are the SOURCE's own; ArchivesSource.validWindow/route are what the owning store actually uses (route is intersected with the store's route).
    sourceConfig?: SourceConfig;
    // Stable identity of the underlying endpoint (its config with windows/routes stripped) - how BlobStore.updateSources recognizes a source across config changes so it can update it in place instead of removing and re-adding it
    identity?: string;
};

// Error marker a server includes when a freshly-stamped write reaches it outside its valid windows (the client resolved its target, then time crossed a window boundary before the write landed). Clients detect this marker and re-resolve the currently-valid source, retrying ONCE - boundaries are far apart, so hitting it twice in one attempt means something is actually wrong.
export const STORAGE_WRONG_VALID_WINDOW = "REMOTE_STORAGE_WRONG_VALID_WINDOW_a7c1f04e";

// Error marker a server includes when a freshly-stamped write's key routes outside the shards this server handles (the client's config disagrees with the server's - clients re-resolve once)
export const STORAGE_WRONG_ROUTE = "REMOTE_STORAGE_WRONG_ROUTE_c94d2e17";

// Error marker a server includes when a write reaches a store whose own routing config has NO entry for it on that server (or that has no routing config at all) - accepting the write would store data nothing scans or reconciles. Clients re-resolve once, exactly like the markers above: the usual cause is the client running a different config than the store.
export const STORAGE_NOT_CONFIGURED = "REMOTE_STORAGE_NOT_CONFIGURED_e51b7d92";

export const FULL_ROUTE: [number, number] = [0, 1];

// A key containing this sentinel doesn't have a fixed shard: setVariableShard picks the (lowest latency, up) write shard, appends "_<value in the shard's route>" directly after the sentinel, and returns the materialized key. getRoute treats that suffix as a complete route override.
export const VARIABLE_SHARD = "VARIABLE_SHARD_f0234jfah08fgyhfgyssdds83nmp";
// No grace past the end: a window boundary is a hard handoff (clients retry a rejected write against the newly-valid source, so leniency here would only desynchronize the handoff)
//  - Writing to older valid state windows is fine, though. We need this to ingest the old data when we're synchronizing nodes to get them up to date anyway. 
export function windowAcceptsWrites(validWindow: [number, number] | undefined): boolean {
    if (!validWindow) return true;
    return validWindow[1] > Date.now();
}
// A source (which can hold several windows) accepts writes while ANY of its windows is still open. No windows = the base disk of an inert store (not in the config), which never receives fan-out writes anyway.
export function windowsAcceptWrites(validWindows: [number, number][]): boolean {
    return validWindows.some(windowAcceptsWrites);
}

// Above this, set transparently streams through setLargeFile: one giant wire message would exceed the transport limit and lag every other client sharing the connection
export const LARGE_SET_THRESHOLD = 8 * 1024 * 1024;

/** The setLargeFile stream over an in-memory buffer, in LARGE_SET_THRESHOLD slices - how set transparently becomes setLargeFile for large buffers. Spread into the config: it provides both getNextData and restartStream (the buffer is still held, so a retry costs nothing). */
export function bufferChunkStream(data: Buffer): { getNextData(): Promise<Buffer | undefined>; restartStream(): void } {
    let offset = 0;
    return {
        getNextData: async () => {
            if (offset >= data.length) return undefined;
            let chunk = data.subarray(offset, offset + LARGE_SET_THRESHOLD);
            offset += chunk.length;
            return chunk;
        },
        restartStream: () => {
            offset = 0;
        },
    };
}

// Re-exported for the existing importers - the implementations (and moveArchiveFile) live in archiveHelpers.ts, beside this interface rather than in it
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
    // Files seen in this source's scans / change polls so far
    scannedCount: number;
};
export type ArchivesSyncStatus = {
    allScansComplete: boolean;
    // Number of files in the index
    indexSize: number;
    sources: ArchivesSyncSourceStatus[];
};

// NOTE: We don't presently have an append function here because a surprising number of storage systems don't support it (backblaze, file system api). It would also complicate things as now there needs to be really a single source of truth of a file, and if you append to the wrong single source of truth, things just become very complicated. 
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
    get2(fileName: string, config?: GetConfig): Promise<{ data: Buffer; writeTime: number; size: number; url?: string } | { data?: undefined; writeTime?: undefined; size?: undefined; url: string } | undefined>;
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
    getInfo(fileName: string, config?: GetInfoConfig): Promise<{ writeTime: number; size: number; url?: string } | undefined>;
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
