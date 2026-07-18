/// <reference types="node" />
/// <reference types="node" />
import { ArchiveFileInfo, ArchivesSource, ArchivesSyncStatus, SyncActivity } from "../IArchives";
export declare const DEFAULT_FAST_WRITE_DELAY: number;
export type WriteConfig = {
    fast?: boolean;
    writeDelay?: number;
    lastModified?: number;
};
export type IBucketStore = {
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
    set(fileName: string, data: Buffer, config?: WriteConfig): Promise<void>;
    del(fileName: string, config?: WriteConfig): Promise<void>;
    getInfo(fileName: string): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo(prefix: string, config?: {
        shallow?: boolean;
        type?: "files" | "folders";
    }): Promise<ArchiveFileInfo[]>;
    getChangesAfter?(time: number): Promise<ArchiveFileInfo[]>;
    getSyncStatus?(): Promise<ArchivesSyncStatus>;
    getSyncProgress?(): {
        index: {
            fileCount: number;
            byteCount: number;
        };
        sources: {
            debugName: string;
            fileCount: number;
            byteCount: number;
        }[];
        readerDiskLimit?: number;
        syncing: SyncActivity[];
    };
    computeIndexTotals?(): Promise<{
        fileCount: number;
        byteCount: number;
        sources: {
            debugName: string;
            fileCount: number;
            byteCount: number;
        }[];
    }>;
    startLargeUpload(): Promise<string>;
    appendLargeUpload(id: string, data: Buffer): Promise<void>;
    finishLargeUpload(id: string, key: string): Promise<void>;
    cancelLargeUpload(id: string): Promise<void>;
};
export declare class BlobStore implements IBucketStore {
    private folder;
    private sources;
    private config?;
    constructor(folder: string, sources: ArchivesSource[], config?: {
        onIndexChanged?: ((key: string) => void) | undefined;
        readerDiskLimit?: number | undefined;
    } | undefined);
    private stopped;
    private index;
    private mem;
    private indexFileCount;
    private indexByteCount;
    private sourceFileCounts;
    private sourceByteCounts;
    private syncActivities;
    private dirty;
    private overlay;
    private sourceStates;
    init: {
        (): Promise<void>;
        reset(): void;
        set(newValue: Promise<void>): void;
    };
    dispose(): Promise<void>;
    private loadIndex;
    private countEntry;
    private setIndexEntry;
    private deleteIndexEntry;
    /** The cheap always-current totals plus any in-progress background synchronization. */
    getSyncProgress(): {
        index: {
            fileCount: number;
            byteCount: number;
        };
        sources: {
            debugName: string;
            fileCount: number;
            byteCount: number;
        }[];
        readerDiskLimit?: number;
        syncing: SyncActivity[];
    };
    /** Walks the whole index for exact totals - more expensive than getSyncProgress, but immune to
     *  any drift in the maintained counters (and loads the index first, so it's never cold zeros). */
    computeIndexTotals(): Promise<{
        fileCount: number;
        byteCount: number;
        sources: {
            debugName: string;
            fileCount: number;
            byteCount: number;
        }[];
    }>;
    private flushIndex;
    private runSourceSync;
    private scanSource;
    private reconcileSource;
    private applyScanned;
    private pollChanges;
    private copySourceFiles;
    private waitForRequiredScans;
    private checkMissingKey;
    private getIndexEntry;
    get(key: string, config?: {
        range?: {
            start: number;
            end: number;
        };
    }): Promise<Buffer | undefined>;
    get2(key: string, config?: {
        range?: {
            start: number;
            end: number;
        };
    }): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
    } | undefined>;
    private cacheRead;
    set(key: string, data: Buffer, config?: WriteConfig): Promise<void>;
    del(key: string, config?: WriteConfig): Promise<void>;
    private getWritableSources;
    private writeToSources;
    getInfo(key: string): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo(prefix: string, config?: {
        shallow?: boolean;
        type?: "files" | "folders";
    }): Promise<ArchiveFileInfo[]>;
    getChangesAfter(time: number): Promise<ArchiveFileInfo[]>;
    getSyncStatus(): Promise<ArchivesSyncStatus>;
    private getDiskSource;
    startLargeUpload(): Promise<string>;
    appendLargeUpload(id: string, data: Buffer): Promise<void>;
    finishLargeUpload(id: string, key: string): Promise<void>;
    cancelLargeUpload(id: string): Promise<void>;
    private flushOverlay;
    private evicting;
    private enforceDiskLimit;
    private cleanupTombstones;
}
