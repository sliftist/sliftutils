/// <reference types="node" />
/// <reference types="node" />
import { ArchiveFileInfo, ArchivesSource, ArchivesSyncStatus } from "../IArchives";
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
    startLargeUpload(): Promise<string>;
    appendLargeUpload(id: string, data: Buffer): Promise<void>;
    finishLargeUpload(id: string, key: string): Promise<void>;
    cancelLargeUpload(id: string): Promise<void>;
};
export declare class BlobStore implements IBucketStore {
    private folder;
    private sources;
    constructor(folder: string, sources: ArchivesSource[]);
    private index;
    private mem;
    private dirty;
    private overlay;
    private sourceStates;
    init: {
        (): Promise<void>;
        reset(): void;
        set(newValue: Promise<void>): void;
    };
    private loadIndex;
    private setIndexEntry;
    private deleteIndexEntry;
    private flushIndex;
    private runSourceSync;
    private scanSource;
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
    } | undefined>;
    private cacheRead;
    set(key: string, data: Buffer, config?: WriteConfig): Promise<void>;
    private writeToSources;
    del(key: string, config?: WriteConfig): Promise<void>;
    private deleteFromSources;
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
}
