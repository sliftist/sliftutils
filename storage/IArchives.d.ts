/// <reference types="node" />
/// <reference types="node" />
export declare const MAX_LAST_MODIFIED_FUTURE: number;
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
    /** The default options for the first config in a list is DEFAULT_BASE_SYNC_OPTIONS. The rest default to DEFAULT_SYNC_OPTIONS. */
    syncOptions?: SyncOptions;
};
export type HostedConfig = CommonConfig & {
    type: "remote";
    url: string;
    accountName?: string;
    public?: boolean;
    fast?: boolean;
    writeDelay?: number;
    rawDisk?: boolean;
    immutable?: boolean;
};
export type BackblazeConfig = CommonConfig & {
    type: "backblaze";
    url: string;
    bucketName: string;
    public?: boolean;
    immutable?: boolean;
};
export declare const DEFAULT_BASE_SYNC_OPTIONS: SyncOptions;
export declare const DEFAULT_SYNC_OPTIONS: SyncOptions;
export type ArchiveFileInfo = {
    path: string;
    createTime: number;
    size: number;
};
export type ArchivesConfig = {
    supportsChangesAfter?: boolean;
};
export type SyncOptions = {
    copyFiles?: boolean;
    noWriteBack?: boolean;
    cacheReads?: boolean;
    validWindow: [number, number];
    required?: boolean;
};
export type ArchivesSource = {
    source: IArchives;
    options: SyncOptions;
};
export type ArchivesSyncSourceStatus = {
    debugName: string;
    options: SyncOptions;
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
    get(fileName: string, config?: {
        range?: {
            start: number;
            end: number;
        };
    }): Promise<Buffer | undefined>;
    /** Like get, but also returns the last-write time of the file. get just calls get2. */
    get2(fileName: string, config?: {
        range?: {
            start: number;
            end: number;
        };
    }): Promise<{
        data: Buffer;
        writeTime: number;
    } | undefined>;
    /**
     * lastModified stamps the write with that last-write time instead of now. If it is OLDER than
     * the file's current last-write time the write no-ops (so delayed / synchronized writes can
     * never clobber newer data). Times more than 15 minutes in the future are rejected.
     */
    set(fileName: string, data: Buffer, config?: {
        lastModified?: number;
    }): Promise<void>;
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
