/// <reference types="node" />
/// <reference types="node" />
export declare const MAX_LAST_MODIFIED_FUTURE: number;
export declare function assertValidLastModified(lastModified: number): void;
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
    writeBack?: boolean;
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
