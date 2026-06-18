/// <reference types="node" />
/// <reference types="node" />
export declare const KEY_COLUMN = "key";
export declare const EMPTY_BUFFER: Buffer;
export declare function buildFileBuffer(rows: Record<string, unknown>[]): Buffer[];
export type BaseBulkDatabaseReader = {
    rowCount: number;
    totalBytes: number;
    keys: string[];
    columns: {
        column: string;
        byteSize: number;
    }[];
    deletedKeys?: Set<string>;
    getColumn: (column: string) => Promise<{
        key: string;
        value: unknown;
    }[]>;
    getSingleField: (key: string, column: string) => Promise<unknown | undefined>;
};
export declare function loadBulkDatabase(config: {
    totalBytes: number;
    getRange: (start: number, end: number) => Promise<Buffer>;
}): Promise<BaseBulkDatabaseReader>;
