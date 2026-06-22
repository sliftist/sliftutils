/// <reference types="node" />
/// <reference types="node" />
export declare const KEY_COLUMN = "key";
export declare const EMPTY_BUFFER: Buffer;
export declare const ABSENT: unique symbol;
export declare const TARGET_FILE_BYTES: number;
export interface BuiltFile {
    buffer: Buffer;
    minKey: string;
    maxKey: string;
    rowCount: number;
}
export declare function buildFileBuffer(rows: Record<string, unknown>[], times: number[], targetBytes?: number): BuiltFile[];
export type BaseBulkDatabaseReader = {
    rowCount: number;
    totalBytes: number;
    minTime: number;
    maxTime: number;
    minKey?: string;
    maxKey?: string;
    keys: string[];
    columns: {
        column: string;
        byteSize: number;
    }[];
    keyTimes: Map<string, number>;
    deleteTimes?: Map<string, number>;
    getColumn: (column: string) => Promise<{
        key: string;
        value: unknown;
        time: number;
    }[]>;
    getSingleField: (key: string, column: string) => Promise<{
        value: unknown;
        time: number;
    } | typeof ABSENT>;
};
export type BulkHeaderInfo = {
    rowCount: number;
    minTime: number;
    maxTime: number;
    minKey?: string;
    maxKey?: string;
    columns: {
        column: string;
        byteSize: number;
    }[];
};
export declare function loadBulkHeader(getRange: (start: number, end: number) => Promise<Buffer>, totalBytes: number): Promise<BulkHeaderInfo>;
export declare function loadBulkDatabase(config: {
    totalBytes: number;
    getRange: (start: number, end: number) => Promise<Buffer>;
}): Promise<BaseBulkDatabaseReader>;
