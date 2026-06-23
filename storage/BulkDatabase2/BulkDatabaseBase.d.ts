import type { FileStorage } from "../FileFolderAPI";
export declare const BULK_ROOT_FOLDER = "bulkDatabases2";
export declare const bulkDatabase2Timing: {
    streamSealAgeMs: number;
    mergeCheckIntervalMs: number;
    mergeSpacingMs: number;
    firstMergeTriggerFiles: number;
    firstMergeTriggerRangeMs: number;
    streamFoldTriggerRows: number;
    streamFoldTriggerBytes: number;
    streamFileMaxBytes: number;
    streamFoldHardLimitBytes: number;
    writeFlushMaxDelayMs: number;
    fileSetPollIntervalMs: number;
    memoryFlushHeapBytes: number;
    memoryFlushMinCollectionBytes: number;
    memoryFlushThrottleMs: number;
};
export interface ReactiveDeps {
    observe(signal: string): void;
    invalidate(signal: string): void;
    batch(fn: () => void): void;
    isObserved?(signal: string): boolean;
}
export declare const noopReactiveDeps: ReactiveDeps;
export type StorageFactory = (path: string) => Promise<FileStorage>;
export type BulkDatabase2Config = {
    maxTriggerThrottleMs?: number;
};
export declare class BulkDatabaseBase<T extends {
    key: string;
}> {
    readonly name: string;
    protected deps: ReactiveDeps;
    private storageFactory;
    private config;
    constructor(name: string, deps: ReactiveDeps, storageFactory: StorageFactory, config?: BulkDatabase2Config);
    private reader;
    private subCaches;
    private pendingAppends;
    private flushTimer;
    private flushChain;
    private currentFlushDelay;
    private lastWriteTime;
    private streamFileName;
    private currentStreamFileName;
    private currentStreamFileBytes;
    private lastMergeCheck;
    private streamRowsOnDisk;
    private streamBytesOnDisk;
    private fileSetPollTimer;
    private rebuildPromise;
    private rebuildDirty;
    private rebuildOptions;
    private static liveInstances;
    private static memoryWatchdogStarted;
    private static lastMemoryFlushMs;
    private static startMemoryWatchdog;
    static checkMemoryPressure(usedHeapBytes: number): void;
    static clearCache(): void;
    static enableNetworkCompaction(): void;
    storage: {
        (): Promise<FileStorage>;
        reset(): void;
        set(newValue: Promise<FileStorage>): void;
    };
    isRemote(): Promise<boolean>;
    private streamNeedsFold;
    private automaticCompactionAllowed;
    isKeyWatched(key: string): boolean;
    private ensureIndex;
    private triggerRebuild;
    private doOneRebuild;
    reloadFromDisk(): void;
    private pollFileSet;
    private readWithRetry;
    private syncSetup;
    private applyRemote;
    write(entry: T): Promise<void>;
    writeBatch(entries: T[]): Promise<void>;
    delete(key: string): Promise<void>;
    deleteBatch(keys: string[]): Promise<void>;
    private streamAppend;
    flush(): Promise<void>;
    private flushPending;
    private doFlush;
    private getStreamFileName;
    private foldOwnStream;
    update(entry: Partial<T> & {
        key: string;
    }): Promise<void>;
    updateBatch(entries: (Partial<T> & {
        key: string;
    })[]): Promise<void>;
    private listFiles;
    private writeBulkFile;
    private maybeMerge;
    tryMergeNow(): Promise<{
        merged: boolean;
        lockFailed: boolean;
    }>;
    compact(): Promise<void>;
    merge(timeLo: number, timeHi: number): Promise<void>;
    private readBulkHeader;
    private fileLogicalSize;
    private handleUnreadableFile;
    private mergeFileSet;
    private canDeleteStream;
    private mergeSpacingDelay;
    private testMerge;
    private findDuplicateGroups;
    getSingleField<C extends keyof T>(key: string, column: C): Promise<T[C] | undefined>;
    getSingleFieldObj<C extends keyof T>(key: string, column: C): Promise<{
        key: string;
        value: T[C];
        time: number;
    } | undefined>;
    getColumn<C extends keyof T>(column: C): Promise<{
        key: string;
        value: T[C];
        time: number;
    }[]>;
    getKeys(): Promise<string[]>;
    getSingleFieldSync<C extends keyof T>(key: string, column: C): T[C] | undefined;
    getSingleFieldObjSync<C extends keyof T>(key: string, column: C): {
        key: string;
        value: T[C];
        time: number;
    } | undefined;
    getColumnSync<C extends keyof T>(column: C): {
        key: string;
        value: T[C];
        time: number;
    }[] | undefined;
    isFieldLoadedSync<C extends keyof T>(key: string, column: C): boolean;
    isColumnLoadedSync<C extends keyof T>(column: C): boolean;
    getColumnInfo(): Promise<{
        column: string;
        byteSize: number;
    }[]>;
    getKeyStats(): Promise<{
        rawKeys: number;
        finalKeys: number;
        wastedKeys: number;
        duplication: number;
        readers: number;
    }>;
    getReaderInfo(): Promise<{
        rowCount: number;
        totalBytes: number;
        keyCount: number;
        sampleKey: string | undefined;
        columns: {
            column: string;
            byteSize: number;
        }[];
    }>;
    getFileInfo(): Promise<{
        files: {
            name: string;
            type: "bulk" | "stream";
            bytes: number;
        }[];
        count: number;
        totalBytes: number;
    }>;
}
