import { SummaryEntry } from "../../treeSummary";
export type AccessSummaryState = {
    total: number;
};
export type AccessTotals = {
    [operation: string]: {
        count: number;
        size: number;
    };
};
/** Counts one storage access, in memory only. size is the bytes involved (0 when the target does not exist); omit it entirely for operations that only count calls, which then only get a count tree. */
export declare function trackAccess(config: {
    account: string;
    operation: string;
    path: string;
    size?: number;
}): void;
/** Method decorator factory, for API methods whose single config-object argument has account and bucketName: tracks the access (as `bucketName/path`) after the method succeeds. Sizes come from the config's data (writes) or the result's data (reads); operations without either are count-only. Array results (listings - findInfo, getChangesAfter) are tracked as two breakdowns: "<op> queries" - one access per CALL, at the query prefix, sized by the number of results (so the tree shows which QUERY returns the most) - and "<op> results" - one count-only access per returned path (so the tree shows which PATHS come back most). */
export declare function trackAccessCall(operation: string): (target: unknown, key: string, descriptor: PropertyDescriptor) => void;
export declare function getAccessTotals(account: string): AccessTotals;
export declare function readAccessSummaries(config: {
    account: string;
    operation: string;
    maxCount: number;
    weightBySize?: boolean;
}): SummaryEntry<AccessSummaryState>[];
export declare function clearAccountAccessStats(account: string): void;
export type BucketWriteStats = {
    /** Every set call the bucket accepted */
    originalWrites: number;
    originalBytes: number;
    /** What actually reached the sources. Fast writes coalesce repeated writes to the same key, so this is lower than the original counts (and is what the disk actually did). */
    flushedWrites: number;
    flushedBytes: number;
};
export declare function countBucketWrite(key: string, kind: "original" | "flushed", bytes: number): void;
export declare function getBucketWriteStats(key: string): BucketWriteStats;
/** Zeroes the write statistics of every bucket in the account. */
export declare function debugClearAccountWriteStats(account: string): number;
