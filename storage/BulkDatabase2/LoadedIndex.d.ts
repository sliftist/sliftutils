import type { FileStorage } from "../FileFolderAPI";
import { BaseBulkDatabaseReader } from "./BulkDatabaseFormat";
import { GetRange } from "./blockCache";
import { StreamEntry } from "./streamLog";
export type BulkFileInfo = {
    fileName: string;
    level: number;
    timestamp: number;
};
export type StreamFileInfo = {
    fileName: string;
    timestamp: number;
};
export type StreamReaderCacheEntry = {
    readSize: number;
    parsedPos: number;
    entries: StreamEntry[];
};
export declare class MissingFileError extends Error {
}
export type ResolvedReader = {
    rowCount: number;
    totalBytes: number;
    keys: string[];
    rawKeyCount: number;
    readerCount: number;
    columns: {
        column: string;
        byteSize: number;
    }[];
    keyTimes: Map<string, number>;
    deleteTimes: Map<string, number>;
    getColumn: (column: string) => Promise<{
        key: string;
        value: unknown;
        time: number;
    }[]>;
    getSingleField: (key: string, column: string) => Promise<{
        value: unknown;
        time: number;
    } | undefined>;
};
export type SubReaderCaches = {
    bulk: Map<string, BaseBulkDatabaseReader>;
    stream: Map<string, StreamReaderCacheEntry>;
};
export declare class LoadedIndex<T extends {
    key: string;
}> {
    readonly name: string;
    readonly storage: FileStorage;
    readonly bulkFiles: BulkFileInfo[];
    readonly streamFiles: StreamFileInfo[];
    readonly reader: ResolvedReader;
    readonly streamTimes: Map<string, number>;
    readonly streamSizes: Map<string, number>;
    readonly streamRowsOnDisk: number;
    readonly streamBytesOnDisk: number;
    readonly subCaches: SubReaderCaches;
    private constructor();
    readonly keys: Set<string>;
    readonly fileSet: Set<string>;
    private baseColumns;
    private baseColumnsLoading;
    private baseFields;
    private baseFieldsLoading;
    private staleBaseColumns;
    private staleBaseFields;
    get totalBytes(): number;
    get rowCount(): number;
    isLive(key: string): boolean;
    static build<T extends {
        key: string;
    }>(config: {
        name: string;
        storage: FileStorage;
        bulkFiles: BulkFileInfo[];
        streamFiles: StreamFileInfo[];
        subCaches: SubReaderCaches;
        onUnreadableFile?: (file: BulkFileInfo, message: string) => Promise<void>;
    }): Promise<LoadedIndex<T>>;
    inheritStaleFrom(prev: LoadedIndex<T>): void;
    getColumn(column: string): Promise<{
        key: string;
        value: unknown;
        time: number;
    }[]>;
    getSingleField(key: string, column: string): Promise<{
        value: unknown;
        time: number;
    } | undefined>;
    ensureBaseColumn(column: string, onLoaded: () => void): void;
    ensureBaseField(key: string, column: string, onLoaded: () => void): void;
    getBaseColumn(column: string): {
        entries: {
            key: string;
            value: unknown;
            time: number;
        }[];
        fresh: boolean;
    } | undefined;
    getBaseField(key: string, column: string): {
        value: {
            value: unknown;
            time: number;
        } | undefined;
        fresh: boolean;
        loaded: boolean;
    };
    isBaseColumnLoaded(column: string): boolean;
    isBaseFieldLoaded(key: string, column: string): boolean;
    dropLoadedValues(): void;
}
export declare function makeRawGetRange(storage: FileStorage, fileName: string): Promise<{
    rawGetRange: GetRange;
    size: number;
}>;
export declare function loadFileReader(name: string, storage: FileStorage, f: BulkFileInfo, cache: Map<string, BaseBulkDatabaseReader>): Promise<BaseBulkDatabaseReader>;
export declare function loadStreamEntries(name: string, storage: FileStorage, streamFiles: StreamFileInfo[], cache: Map<string, StreamReaderCacheEntry>): Promise<{
    entries: {
        time: number;
        fileName: string;
        entry: StreamEntry;
    }[];
    totalBytes: number;
    missing: boolean;
    sizes: Map<string, number>;
}>;
export declare function orderStreamEntries(entries: {
    time: number;
    fileName: string;
    entry: StreamEntry;
}[]): StreamEntry[];
