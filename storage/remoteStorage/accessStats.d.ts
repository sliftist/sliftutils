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
/** Method decorator factory, for API methods whose single config-object argument has account and bucketName: tracks the access (as `bucketName/path`) after the method succeeds. Sizes come from the config's data (writes) or the result's data (reads); operations without either are count-only. Array results (listings) track one access per returned path, or a single access at the prefix when empty. */
export declare function trackAccessCall(operation: string): (target: unknown, key: string, descriptor: PropertyDescriptor) => void;
export declare function getAccessTotals(account: string): AccessTotals;
export declare function readAccessSummaries(config: {
    account: string;
    operation: string;
    maxCount: number;
    weightBySize?: boolean;
}): SummaryEntry<AccessSummaryState>[];
export declare function clearAccountAccessStats(account: string): void;
