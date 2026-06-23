/// <reference types="node" />
/// <reference types="node" />
import { BaseBulkDatabaseReader } from "./BulkDatabaseFormat";
type CopyRun = {
    sourceIdx: number;
    sourceStartRow: number;
    sourceEndRow: number;
    outputByteStart: number;
    byteLength: number;
};
type PlannedOutputColumn = {
    name: string;
    offsets: Uint32Array;
    types: Uint8Array;
    dataLength: number;
    runs: CopyRun[];
};
export type PlannedOutputFile = {
    keys: string[];
    times: number[];
    minKey: string;
    maxKey: string;
    columns: PlannedOutputColumn[];
    estimatedFileBytes: number;
    sourceCounts: Map<number, number>;
};
export type PlannedMergeOutput = {
    name: string;
    minKey: string;
    maxKey: string;
    rowCount: number;
    size: number;
    sources: Map<string, number>;
};
export declare function runPlannedMerge(config: {
    sources: BaseBulkDatabaseReader[];
    sourceNames: string[];
    collectionName: string;
    targetFileBytes?: number;
    targetBatchBytes?: number;
    log?: (line: string) => void;
    writeFile: (data: Buffer) => Promise<{
        name: string;
        size: number;
    }>;
}): Promise<{
    outputs: PlannedMergeOutput[];
    carriedDeletes: Map<string, number>;
}>;
export {};
