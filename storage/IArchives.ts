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
export type RemoteConfigBase = string | HostedConfig | BackblazeConfig;

export type CommonConfig = {
    /** By default a server hosting this bucket eagerly copies this source's full contents onto its own disk (on top of the lazy read-through caching). Set this to be a front end for a very large database without copying the full database - reads still down-cache individual files on demand. */
    noFullSync?: boolean;
    /** Bytes of read-cache this server's disk may hold; least-recently-used files are deleted from disk to stay under it (only ever when another source verifiably holds the file - the only copy is never deleted). Requires noFullSync (a full copy can't be bounded). */
    readerDiskLimit?: number;
    /** The write times ([startMs, endMs]) this source is valid for (see ArchivesSource.validWindow for the synchronization semantics). Required on object configs: configuration changes must be SCHEDULED (a new source becomes valid at a future time while the old one's window ends), not flipped instantly. Plain URL-string sources default to FULL_VALID_WINDOW - once you're writing object configs, you're doing something complicated enough to think about when things change. */
    validWindow: [number, number];
    /** Sharding: the fraction of the key space this source handles, as [start, end) over [0, 1) (keys are routed by getRoute in remoteConfig.ts). Defaults to FULL_ROUTE (unsharded). At every point in time the sources' routes must fully cover [0, 1), or some keys could never be read. */
    route?: [number, number];
    /** Set on entries injected into the in-memory config by an overlay (a deploy switchover's alternate-port window). Never written to disk: resolveIntermediateSources strips these and rejoins the windows around them, which is also how a client tells whether an update is a real configuration change or just an overlay. */
    intermediate?: boolean;
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
    // The bucket is served straight from the server's disk, with no index — so no fast writes, no getSyncStatus, and getChangesAfter2 falls back to a full listing.
    rawDisk?: boolean;
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
};

export type ChangesAfterConfig = {
    time: number;
    /** Only keys routing into one of these [start, end) ranges. Only scanning passes this - it lets a store syncing a partial shard ask for just its slice. */
    routes?: [number, number][];
};

export type SetConfig = {
    lastModified?: number;
    /** Makes the write acceptable on immutable targets: an existing path is simply kept (immutability wins - nothing is overwritten) instead of the write throwing. Requires lastModified. Synchronization MUST pass this on every push - a plain set throws on immutable targets, which would abort reconciliation whenever one source in a chain is immutable. */
    forceSetImmutable?: boolean;
    /** Skips the target-side safety reads around the write (backblaze: the pre-write getInfo comparison and the post-upload existence poll). For writers whose own bookkeeping already decides what to write and orders it by write time (BlobStore's index-driven writes and synchronization), those reads are pure extra API calls - but the default stays checked, because other users of the raw backends rely on the checks. */
    noChecks?: boolean;
};

// createTime is a misnomer kept for compatibility — it is really the LAST-WRITE time, same as getInfo's writeTime. Neither Backblaze nor our remote storage tracks a distinct creation date: each write stamps a fresh timestamp on the current version, so both fields are just "when the bytes served by get() were most recently written".
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
    // From the source's CommonConfig. The window routes WRITES: once its end is past (see windowAcceptsWrites) the source stops receiving writes entirely - it just stops growing. It does NOT filter scanning: a scan is us asking the source what it already holds, and existing values synchronize regardless of their write times (the same reasoning that lets synchronization ignore the immutable flag).
    validWindow: [number, number];
    // From the source's CommonConfig (intersected with the owning store's own route): only keys routing into [start, end) are accepted from this source's scans and sent to it in writes/reconciliation. The routing file is exempt - config flows everywhere. Absent = all keys.
    route?: [number, number];
    // From the source's CommonConfig; see there.
    noFullSync?: boolean;
    // From the source's CommonConfig: a deploy switchover's temporary alternate-port entry. Once its window is past, the port it points at is gone for good - so it is never scanned then, and scan failures are never retried.
    intermediate?: boolean;
    // Stable identity of the underlying endpoint (its config with windows/routes stripped) - how BlobStore.updateSources recognizes a source across config changes so it can update it in place instead of removing and re-adding it
    identity?: string;
};

// Error marker a server includes when a freshly-stamped write reaches it outside its valid windows (the client resolved its target, then time crossed a window boundary before the write landed). Clients detect this marker and re-resolve the currently-valid source, retrying ONCE - boundaries are far apart, so hitting it twice in one attempt means something is actually wrong.
export const STORAGE_WRONG_VALID_WINDOW = "REMOTE_STORAGE_WRONG_VALID_WINDOW_a7c1f04e";

// Error marker a server includes when a freshly-stamped write's key routes outside the shards this server handles (the client's config disagrees with the server's - clients re-resolve once)
export const STORAGE_WRONG_ROUTE = "REMOTE_STORAGE_WRONG_ROUTE_c94d2e17";

export const FULL_ROUTE: [number, number] = [0, 1];

// A key containing this sentinel doesn't have a fixed shard: setVariableShard picks the (lowest latency, up) write shard, appends "_<value in the shard's route>" directly after the sentinel, and returns the materialized key. getRoute treats that suffix as a complete route override.
export const VARIABLE_SHARD = "VARIABLE_SHARD_f0234jfah08fgyhfgyssdds83nmp";
// No grace past the end: a window boundary is a hard handoff (clients retry a rejected write against the newly-valid source, so leniency here would only desynchronize the handoff)
//  - Writing to older valid state windows is fine, though. We need this to ingest the old data when we're synchronizing nodes to get them up to date anyway. 
export function windowAcceptsWrites(validWindow: [number, number] | undefined): boolean {
    if (!validWindow) return true;
    return validWindow[1] > Date.now();
}

const LARGE_COPY_THRESHOLD = 64 * 1024 * 1024;
const LARGE_COPY_CHUNK = 32 * 1024 * 1024;

/** Copies one file between two archives. Small files go as a single get2+set; past LARGE_COPY_THRESHOLD the copy streams through setLargeFile in LARGE_COPY_CHUNK ranged reads, so the whole file is never in memory. size/writeTime usually come from the caller's metadata scan; when either is omitted, getInfo fills them in. Returns the copied file's info, or undefined when the source doesn't have the file. */
export async function copyArchiveFile(config: {
    from: IArchives;
    to: IArchives;
    path: string;
    size?: number;
    writeTime?: number;
    forceSetImmutable?: boolean;
    noChecks?: boolean;
}): Promise<{ writeTime: number; size: number } | undefined> {
    let { from, to, path } = config;
    let size = config.size;
    let writeTime = config.writeTime;
    if (size === undefined || writeTime === undefined) {
        let info = await from.getInfo(path);
        if (!info) return undefined;
        size = info.size;
        writeTime = info.writeTime;
    }
    if (size <= LARGE_COPY_THRESHOLD) {
        let result = await from.get2(path);
        if (!result) return undefined;
        await to.set(path, result.data, { lastModified: result.writeTime, forceSetImmutable: config.forceSetImmutable, noChecks: config.noChecks });
        return { writeTime: result.writeTime, size: result.data.length };
    }
    // Consts so the closure keeps the narrowed types
    const totalSize = size;
    const finalWriteTime = writeTime;
    let offset = 0;
    await to.setLargeFile({
        path,
        lastModified: finalWriteTime,
        getNextData: async () => {
            if (offset >= totalSize) return undefined;
            let end = Math.min(offset + LARGE_COPY_CHUNK, totalSize);
            let data = await from.get(path, { range: { start: offset, end } });
            if (!data || !data.length) {
                throw new Error(`Ranged read of ${JSON.stringify(path)} from ${from.getDebugName()} returned ${data && data.length || "nothing"} at ${offset}-${end} (expected ${end - offset} bytes of a ${totalSize} byte file - it changed or vanished mid-copy)`);
            }
            offset += data.length;
            return data;
        },
    });
    return { writeTime: finalWriteTime, size: totalSize };
}

export type ArchivesSyncSourceStatus = {
    debugName: string;
    validWindow: [number, number];
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
    /** See get for the fallback semantics (and when to pass noFallbacks). url is the config URL of the source that served the value - set by multi-source implementations (ArchivesChain), absent from single-source backends. */
    get2(fileName: string, config?: GetConfig): Promise<{ data: Buffer; writeTime: number; size: number; url?: string } | undefined>;
    /**
     * lastModified stamps the write with that last-write time instead of now. If it is OLDER than
     * the file's current last-write time the write no-ops (so delayed / synchronized writes can
     * never clobber newer data). Times more than 15 minutes in the future are rejected.
     *
     * Returns the full key actually written - identical to fileName, EXCEPT for keys containing
     * VARIABLE_SHARD, where the shard value is materialized into the key (picked by shard latency,
     * see ArchivesChain) and the caller needs the returned key to ever read the value back.
     */
    set(fileName: string, data: Buffer, config?: SetConfig): Promise<string>;
    del(fileName: string): Promise<void>;
    /** Streams a file too large to hold in memory. getNextData returns undefined when done. lastModified stamps the finished file like set's (synchronized copies need it to keep write ordering); backends that stamp their own times (backblaze) accept and ignore it. */
    setLargeFile(config: { path: string; lastModified?: number; getNextData(): Promise<Buffer | undefined> }): Promise<void>;
    /** writeTime is the last-write time — see ArchiveFileInfo.createTime, which is the same value. url as in get2. */
    getInfo(fileName: string): Promise<{ writeTime: number; size: number; url?: string } | undefined>;
    find(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<string[]>;
    findInfo(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<ArchiveFileInfo[]>;
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
