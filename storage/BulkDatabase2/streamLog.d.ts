/// <reference types="node" />
/// <reference types="node" />
import { BaseBulkDatabaseReader } from "./BulkDatabaseFormat";
export declare const STREAM_EXTENSION = ".stream";
export type StreamEntry = {
    time: number;
    row?: Record<string, unknown>;
    deletedKey?: string;
};
export declare function frameRows(entries: {
    time: number;
    row: Record<string, unknown>;
}[]): Buffer;
export declare function frameDeletes(entries: {
    time: number;
    key: string;
}[]): Buffer;
export declare function parseStream(buffer: Buffer): {
    entries: StreamEntry[];
    badBytes: number;
};
export declare function streamReaderFromEntries(entries: StreamEntry[], totalBytes: number): {
    reader: BaseBulkDatabaseReader;
    times: Map<string, number>;
};
