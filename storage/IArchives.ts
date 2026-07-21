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
    // The bucket is served straight from the server's disk, with no index — so no fast writes and no getChangesAfter/getSyncStatus.
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
    // Whether getChangesAfter is implemented (fast change polling, instead of full rescans)
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
    // From the source's CommonConfig. Values with write times outside the window are ignored when scanning, and once its end is past (see windowAcceptsWrites) the source stops receiving writes entirely - still scanned (it holds the authoritative data for its window), it just stops growing.
    validWindow: [number, number];
    // From the source's CommonConfig (intersected with the owning store's own route): only keys routing into [start, end) are accepted from this source's scans and sent to it in writes/reconciliation. The routing file is exempt - config flows everywhere. Absent = all keys.
    route?: [number, number];
    // From the source's CommonConfig; see there.
    noFullSync?: boolean;
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
export function windowAcceptsWrites(validWindow: [number, number] | undefined): boolean {
    if (!validWindow) return true;
    return validWindow[1] > Date.now();
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
    get(fileName: string, config?: { range?: { start: number; end: number } }): Promise<Buffer | undefined>;
    get2(fileName: string, config?: { range?: { start: number; end: number } }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined>;
    /**
     * lastModified stamps the write with that last-write time instead of now. If it is OLDER than
     * the file's current last-write time the write no-ops (so delayed / synchronized writes can
     * never clobber newer data). Times more than 15 minutes in the future are rejected.
     *
     * Returns the full key actually written - identical to fileName, EXCEPT for keys containing
     * VARIABLE_SHARD, where the shard value is materialized into the key (picked by shard latency,
     * see ArchivesChain) and the caller needs the returned key to ever read the value back.
     */
    set(fileName: string, data: Buffer, config?: { lastModified?: number }): Promise<string>;
    del(fileName: string): Promise<void>;
    /** Streams a file too large to hold in memory. getNextData returns undefined when done. */
    setLargeFile(config: { path: string; getNextData(): Promise<Buffer | undefined> }): Promise<void>;
    /** writeTime is the last-write time — see ArchiveFileInfo.createTime, which is the same value. */
    getInfo(fileName: string): Promise<{ writeTime: number; size: number } | undefined>;
    find(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<string[]>;
    findInfo(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<ArchiveFileInfo[]>;
    /** Only works for public buckets (private buckets are API-access only). */
    getURL(path: string): Promise<string>;
    /** The bucket's configuration, which tells whether the optional functions are supported. */
    getConfig(): Promise<ArchivesConfig>;
    /**
     * All files changed after the given time. Only exists when getConfig().supportsChangesAfter;
     * backed by an index, so it is fast (unlike a full findInfo scan). Deletions are not reported.
     */
    getChangesAfter?(time: number): Promise<ArchiveFileInfo[]>;
    /** Synchronization introspection, for backends that synchronize from sources (see BlobStore). */
    getSyncStatus?(): Promise<ArchivesSyncStatus>;
}
