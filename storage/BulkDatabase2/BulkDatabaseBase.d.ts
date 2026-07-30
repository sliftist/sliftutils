import type { FileStorage } from "../FileFolderAPI";
import { BulkFileInfo, StreamFileInfo } from "./LoadedIndex";
export declare const BULK_ROOT_FOLDER = "bulkDatabases2";
export declare const bulkDatabase2Timing: {
    streamSealAgeMs: number;
    visibleMergeIntervalMs: number;
    mergeSpacingMs: number;
    looseBulkTriggerBytes: number;
    looseBulkTriggerFiles: number;
    streamFoldTriggerBytes: number;
    streamFileMaxBytes: number;
    liveWriterProbeMs: number;
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
export type MergeSkipReason = "mergeInFlight" | "tabLockHeld" | "fileLockHeld" | "nothingToMerge";
export type MergeAttemptResult = {
    merged: boolean;
    skipReason?: MergeSkipReason;
    lockHolderId?: string;
    lockExpiresInMs?: number;
};
/** One threshold a compaction step is measured against. `value` is where the collection stands now and `threshold` is what sets the step off, so `fraction` (value/threshold) reads as how close it is - 1 or more means met. Deliberately not clamped, so an overdue step reads as how far past due it is. */
export type CompactionTrigger = {
    name: string;
    value: number;
    threshold: number;
    fraction: number;
    met: boolean;
    /** How to render value/threshold. "fraction" values are 0..1. */
    unit: "bytes" | "count" | "fraction";
};
/** streamHardLimit and streamFold are phase 1 (stream -> bulk), looseCombine is phase 2 (loose bulk -> combined bulk), dedupAll and dedupKeyGroup are phase 3. */
export type CompactionStepKind = "streamHardLimit" | "streamFold" | "looseCombine" | "dedupAll" | "dedupKeyGroup";
export type CompactionStep = {
    phase: 1 | 2 | 3;
    kind: CompactionStepKind;
    /** Whether this step runs on the next pass. Authoritative: on top of `requires` it accounts for inputs the step needs beyond its thresholds (e.g. two files to combine), so it can be false even with every trigger met. */
    ready: boolean;
    /** Whether every trigger has to be met for this step, or just one of them. */
    requires: "any" | "all";
    triggers: CompactionTrigger[];
    /** When this step's merge starts, given merges are spaced mergeSpacingMs apart. Only set when ready. */
    startTime?: number;
    /** The files this step consumes, as of when the plan was made. */
    bulkFiles: BulkFileInfo[];
    streamFiles: StreamFileInfo[];
    /** Total size of those inputs. */
    bytes: number;
    /** dedupKeyGroup only - the key range the step rewrites. */
    keyRange?: {
        lo: string;
        hi: string;
    };
};
/** Every compaction the current file set calls for, in the order a merge pass runs them, plus how close each not-yet-ready one is to its thresholds. */
export type CompactionPlan = {
    collection: string;
    /** When the plan was computed; every startTime is measured from here. */
    time: number;
    steps: CompactionStep[];
};
export declare class BulkDatabaseBase<T extends {
    key: string;
}> {
    readonly name: string;
    protected deps: ReactiveDeps;
    private storageFactory;
    private config;
    constructor(name: string, deps: ReactiveDeps, storageFactory: StorageFactory, config?: BulkDatabase2Config);
    private _reader;
    private get reader();
    private activated;
    private activate;
    private setupVisibilityMergeCheck;
    private subCaches;
    private pendingAppends;
    private flushTimer;
    private flushChain;
    private currentFlushDelay;
    private lastWriteTime;
    private streamFileName;
    private currentStreamFileName;
    private currentStreamFileBytes;
    private mergeInFlight;
    private lastMergeSkipLogMs;
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
    private findAbandonedStreams;
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
    private processMarkers;
    private writeBulkFile;
    private maybeMerge;
    private mergeSkip;
    private runLockedMerge;
    private tryMergeThrottled;
    tryMergeNow(): Promise<MergeAttemptResult>;
    compact(): Promise<MergeAttemptResult>;
    merge(timeLo: number, timeHi: number): Promise<void>;
    private readBulkHeader;
    private fileLogicalSize;
    private handleUnreadableFile;
    private mergeFileSet;
    private mergeFileSetInner;
    private canDeleteStream;
    private mergeSpacingDelay;
    private splitBulkTier;
    private analyzeDuplicates;
    private filesForKeyRange;
    /**
     * Every compaction the files on disk currently call for, without performing any of them. A merge pass
     * builds exactly this and then runs the steps whose `ready` is true, so the plan is precisely what the
     * database is about to do — and a step that isn't ready still reports its `triggers`, so a caller can
     * see how close it is (50MB of stream data out of the 64MB that would fold it, and so on).
     *
     * O(total keys): the phase 3 steps need every combined file's key list walked.
     */
    planCompaction(): Promise<CompactionPlan>;
    private testMergeINTERNAL_DO_NOT_CALL;
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
    isCompactingSync(): boolean;
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
    getFileInfo(): Promise<BulkFileInfoListing>;
}
export type BulkFileDetails = {
    keys: string[];
    minTime: number;
    maxTime: number;
};
export type BulkFileEntry = {
    name: string;
    type: "bulk" | "stream";
    bytes: number;
    lastModified: number;
    getDetails: () => Promise<BulkFileDetails>;
};
export type BulkFileInfoListing = {
    files: BulkFileEntry[];
    count: number;
    totalBytes: number;
};
