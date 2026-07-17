module.allowclient = true;

// The important operations of an archive bucket (extracted from ArchivesBackblaze), so other
// backends (e.g. our own remote storage server) can be used interchangeably.

// A write may not be stamped more than this far in the future, or clock skew between machines
// would let a bad timestamp block writes for a long time.
export const MAX_LAST_MODIFIED_FUTURE = 15 * 60 * 1000;
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
    /** The default options for the first config in a list is DEFAULT_BASE_SYNC_OPTIONS. The rest default to DEFAULT_SYNC_OPTIONS. */
    syncOptions?: SyncOptions;
};

export type HostedConfig = CommonConfig & {
    type: "remote";

    // Ex: https://storage2.vidgridweb.com:4445/file/exampleaccount/examplebucket/storage/storagerouting.json
    // NOTE: The account and bucket name are obtained from the URL.
    url: string;

    // NOTE: Authentication is handled by cert.ts, via having your machine trusted to access this account. 
    accountName?: string;

    public?: boolean;
    // Fast mode: the server acknowledges writes once they are in memory, flushing to disk after
    // writeDelay (default 5 minutes) and coalescing writes to the same file. A server crash loses
    // writes that haven't flushed yet.
    fast?: boolean;
    writeDelay?: number;
    // The bucket is served straight from the server's disk, with no index — so no fast writes and
    // no getChangesAfter/getSyncStatus.
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
    bucketName: string;
    public?: boolean;
    // NOTE: This isn't enforced on the backblaze level, so this is just a client-side guarantee. This can change how we cache files.
    //  - Backblaze does support immutability. However, apparently, once we enable it on a bucket, we can't disable it, which is really bad, as it means if our code could ever enable it and we accidentally enable it on an important bucket, we essentially just bricked that bucket. So we should never write any code that ever tries to use backblaze to make things immutable. 
    immutable?: boolean;

    // NOTE: We will access the api key from getSecret, see backblaze.ts for the specific keys.
};


export const DEFAULT_BASE_SYNC_OPTIONS: SyncOptions = {
    cacheReads: true,
    required: true,
    validWindow: [0, Number.MAX_SAFE_INTEGER],
};
export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
    validWindow: [0, Number.MAX_SAFE_INTEGER],
};



// createTime is a misnomer kept for compatibility — it is really the LAST-WRITE time, same as
// getInfo's writeTime. Neither Backblaze nor our remote storage tracks a distinct creation date:
// each write stamps a fresh timestamp on the current version, so both fields are just "when the
// bytes served by get() were most recently written".
export type ArchiveFileInfo = { path: string; createTime: number; size: number };

export type ArchivesConfig = {
    // Whether getChangesAfter is implemented (fast change polling, instead of full rescans)
    supportsChangesAfter?: boolean;
};

// How a synchronization source behaves (see BlobStore, which synchronizes an index + local cache
// from a list of { source, options }).
export type SyncOptions = {
    // After the source's metadata is copied into the index, also copy the file contents over (into
    // the cacheReads sources), preserving their modified times.
    copyFiles?: boolean;
    // Writes are NOT written to this source (by default every source receives writes).
    noWriteBack?: boolean;
    // If a read wasn't served by this source, write the data back to it (using it as a cache), and
    // update the index so it becomes the new source. Set for the local disk source.
    cacheReads?: boolean;
    // Ignore values with write times outside [start, end].
    validWindow: [number, number];
    // If a file isn't in the index and this source hasn't finished its initial scan, check the
    // source directly before declaring the file nonexistent. Set for the disk source.
    required?: boolean;
};
export type ArchivesSource = { source: IArchives; options: SyncOptions };

export type ArchivesSyncSourceStatus = {
    debugName: string;
    options: SyncOptions;
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
    get(fileName: string, config?: { range?: { start: number; end: number } }): Promise<Buffer | undefined>;
    /** Like get, but also returns the last-write time of the file. get just calls get2. */
    get2(fileName: string, config?: { range?: { start: number; end: number } }): Promise<{ data: Buffer; writeTime: number } | undefined>;
    /**
     * lastModified stamps the write with that last-write time instead of now. If it is OLDER than
     * the file's current last-write time the write no-ops (so delayed / synchronized writes can
     * never clobber newer data). Times more than 15 minutes in the future are rejected.
     */
    set(fileName: string, data: Buffer, config?: { lastModified?: number }): Promise<void>;
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
