import type { FileStorage } from "../FileFolderAPI";
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
    private streamRowsWritten;
    private getStreamFileName;
    private invalidateOverlay;
    private setOverlayRow;
    private setOverlayDeleted;
    private reader;
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
    private writeBulkFile;
    private listStreamFiles;
    private loadStreamEntries;
    private orderStreamEntries;
    private maybeRolloverStream;
    private rolloverStream;
    compact(): Promise<void>;
    private listFiles;
    private makeRawGetRange;
    private loadFileReader;
    private fileLogicalSize;
    private handleUnreadableFile;
    private mergeFilesBase;
    private mergeFiles;
    private formatInfo;
    private patchColumn;
    getSingleField<Column extends keyof T>(key: string, column: Column): Promise<T[Column] | undefined>;
    getColumn<Column extends keyof T>(column: Column): Promise<{
        key: string;
        value: T[Column];
    }[]>;
    getKeys(): Promise<string[]>;
    private baseColumns;
    private baseColumnsLoading;
    private baseFields;
    private baseFieldsLoading;
    private ensureBaseColumn;
    private ensureBaseField;
    getSingleFieldSync<Column extends keyof T>(key: string, column: Column): T[Column] | undefined;
    getColumnSync<Column extends keyof T>(column: Column): {
        key: string;
        value: T[Column];
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
