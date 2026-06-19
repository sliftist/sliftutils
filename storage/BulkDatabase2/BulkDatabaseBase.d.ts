import type { FileStorage } from "../FileFolderAPI";
export declare const bulkDatabase2Timing: {
    streamSealAgeMs: number;
    mergeCheckIntervalMs: number;
    firstMergeTriggerFiles: number;
    firstMergeTriggerRangeMs: number;
};
export interface ReactiveDeps {
    observe(signal: string): void;
    invalidate(signal: string): void;
    batch(fn: () => void): void;
}
export declare const noopReactiveDeps: ReactiveDeps;
export type StorageFactory = (path: string) => Promise<FileStorage>;
export declare class BulkDatabaseBase<T extends {
    key: string;
}> {
    readonly name: string;
    protected deps: ReactiveDeps;
    private storageFactory;
    constructor(name: string, deps: ReactiveDeps, storageFactory: StorageFactory);
    static clearCache(): void;
    storage: {
        (): Promise<FileStorage>;
        reset(): void;
        set(newValue: Promise<FileStorage>): void;
    };
    private overlay;
    private streamTimes;
    private streamFileName;
    private lastMergeCheck;
    private getStreamFileName;
    private invalidateOverlay;
    private setOverlayRow;
    private setOverlayDeleted;
    private reader;
    private buildReader;
    private syncSetup;
    private localTime;
    private applyRemote;
    private resetReader;
    write(entry: T): Promise<void>;
    writeBatch(entries: T[]): Promise<void>;
    delete(key: string): Promise<void>;
    deleteBatch(keys: string[]): Promise<void>;
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
    private readBulkHeader;
    private fileLogicalSize;
    private handleUnreadableFile;
    private resolveReaders;
    private mergeFileSet;
    private canDeleteStream;
    private testMerge;
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
    getColumnInfo(): Promise<{
        column: string;
        byteSize: number;
    }[]>;
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
}
