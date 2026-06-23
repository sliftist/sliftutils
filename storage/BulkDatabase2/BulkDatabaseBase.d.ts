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
    private static liveInstances;
    private static memoryWatchdogStarted;
    private static lastMemoryFlushMs;
    private static startMemoryWatchdog;
    static checkMemoryPressure(usedHeapBytes: number): void;
    private pendingAppends;
    private flushTimer;
    private flushChain;
    private currentFlushDelay;
    private lastWriteTime;
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
    private overlay;
    private streamTimes;
    private columnCache;
    private readerKeys;
    private loadedFileSet;
    private loadedTotalBytes;
    private readerEpoch;
    private fileSetPollTimer;
    private bulkReaderCache;
    private streamReaderCache;
    private dataGen;
    private pendingSignals;
    private triggerTimer;
    private currentTriggerDelay;
    private lastTriggerTime;
    private streamRowsOnDisk;
    private streamBytesOnDisk;
    private streamFileName;
    private currentStreamFileName;
    private currentStreamFileBytes;
    private lastMergeCheck;
    private getStreamFileName;
    private invalidateOverlay;
    isKeyWatched(key: string): boolean;
    private isLiveNow;
    private invalidateSignal;
    private flushSignals;
    private setOverlayRow;
    private setOverlayDeleted;
    private reader;
    private buildReader;
    private syncSetup;
    private localTime;
    private applyRemote;
    private clearReaderState;
    private resetReader;
    private reloadReader;
    reloadFromDisk(): void;
    private readWithReload;
    private pollFileSet;
    write(entry: T): Promise<void>;
    writeBatch(entries: T[]): Promise<void>;
    delete(key: string): Promise<void>;
    deleteBatch(keys: string[]): Promise<void>;
    private streamAppend;
    flush(): Promise<void>;
    private flushPending;
    private doFlush;
    private foldOwnStream;
    update(entry: Partial<T> & {
        key: string;
    }): Promise<void>;
    updateBatch(entries: (Partial<T> & {
        key: string;
    })[]): Promise<void>;
    private listFiles;
    private writeBulkFile;
    private loadStreamEntries;
    private orderStreamEntries;
    private maybeMerge;
    tryMergeNow(): Promise<{
        merged: boolean;
        lockFailed: boolean;
    }>;
    compact(): Promise<void>;
    merge(timeLo: number, timeHi: number): Promise<void>;
    private makeRawGetRange;
    private loadFileReader;
    private pruneFileCaches;
    private readBulkHeader;
    private fileLogicalSize;
    private handleUnreadableFile;
    private mergeFileSet;
    private canDeleteStream;
    private mergeSpacingDelay;
    private testMerge;
    private findDuplicateGroups;
    private formatInfo;
    private patchColumn;
    getSingleField<Column extends keyof T>(key: string, column: Column): Promise<T[Column] | undefined>;
    getSingleFieldObj<Column extends keyof T>(key: string, column: Column): Promise<{
        key: string;
        value: T[Column];
        time: number;
    } | undefined>;
    getColumn<Column extends keyof T>(column: Column): Promise<{
        key: string;
        value: T[Column];
        time: number;
    }[]>;
    getKeys(): Promise<string[]>;
    private baseColumns;
    private baseColumnsLoading;
    private baseFields;
    private baseFieldsLoading;
    private staleBaseColumns;
    private staleBaseFields;
    private ensureBaseColumn;
    private ensureBaseField;
    getSingleFieldSync<Column extends keyof T>(key: string, column: Column): T[Column] | undefined;
    getSingleFieldObjSync<Column extends keyof T>(key: string, column: Column): {
        key: string;
        value: T[Column];
        time: number;
    } | undefined;
    getColumnSync<Column extends keyof T>(column: Column): {
        key: string;
        value: T[Column];
        time: number;
    }[] | undefined;
    isFieldLoadedSync<Column extends keyof T>(key: string, column: Column): boolean;
    isColumnLoadedSync<Column extends keyof T>(column: Column): boolean;
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
