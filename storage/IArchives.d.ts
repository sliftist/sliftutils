/// <reference types="node" />
/// <reference types="node" />
export declare const MAX_LAST_MODIFIED_FUTURE: number;
export declare const IMMUTABLE_CACHE_TIME: number;
export declare function assertValidLastModified(lastModified: number): void;
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
    url: string;
    public?: boolean;
    fast?: boolean;
    writeDelay?: number;
    rawDisk?: boolean;
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
    validWindow: [number, number];
    route?: [number, number];
    noFullSync?: boolean;
    identity?: string;
};
export declare const STORAGE_WRONG_VALID_WINDOW = "REMOTE_STORAGE_WRONG_VALID_WINDOW_a7c1f04e";
export declare const STORAGE_WRONG_ROUTE = "REMOTE_STORAGE_WRONG_ROUTE_c94d2e17";
export declare const FULL_ROUTE: [number, number];
export declare const VARIABLE_SHARD = "VARIABLE_SHARD_f0234jfah08fgyhfgyssdds83nmp";
export declare function windowAcceptsWrites(validWindow: [number, number] | undefined): boolean;
export type ArchivesSyncSourceStatus = {
    debugName: string;
    validWindow: [number, number];
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
    get(fileName: string, config?: {
        range?: {
            start: number;
            end: number;
        };
    }): Promise<Buffer | undefined>;
    get2(fileName: string, config?: {
        range?: {
            start: number;
            end: number;
        };
    }): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
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
    set(fileName: string, data: Buffer, config?: {
        lastModified?: number;
    }): Promise<string>;
    del(fileName: string): Promise<void>;
    /** Streams a file too large to hold in memory. getNextData returns undefined when done. */
    setLargeFile(config: {
        path: string;
        getNextData(): Promise<Buffer | undefined>;
    }): Promise<void>;
    /** writeTime is the last-write time — see ArchiveFileInfo.createTime, which is the same value. */
    getInfo(fileName: string): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    find(prefix: string, config?: {
        shallow?: boolean;
        type: "files" | "folders";
    }): Promise<string[]>;
    findInfo(prefix: string, config?: {
        shallow?: boolean;
        type: "files" | "folders";
    }): Promise<ArchiveFileInfo[]>;
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
