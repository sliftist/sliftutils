import { TreeSummary, SummaryEntry } from "../../treeSummary";

const EXPECTED_OUTPUT_COUNT = 100;

export type AccessSummaryState = { total: number };
export type AccessTotals = { [operation: string]: { count: number; size: number } };

type AccessValue = { path: string; size: number };
type OperationStats = {
    totalCount: number;
    totalSize: number;
    countTree: TreeSummary<AccessValue, AccessSummaryState>;
    // Only exists for operations tracked with sizes; count-only operations (getInfo, del, ...) have no meaningful size breakdown.
    sizeTree?: TreeSummary<AccessValue, AccessSummaryState>;
};

const accounts = new Map<string, Map<string, OperationStats>>();

function makeTree(getValue: (value: AccessValue) => number): TreeSummary<AccessValue, AccessSummaryState> {
    return new TreeSummary<AccessValue, AccessSummaryState>({
        getPath: value => value.path,
        createSummary: () => ({ total: 0 }),
        addToSummary: (value, summary) => {
            summary.total += getValue(value);
        },
        mergeSummaries: (target, source) => {
            target.total += source.total;
        },
        getWeight: summary => summary.total,
        expectedOutputCount: EXPECTED_OUTPUT_COUNT,
    });
}

/** Counts one storage access, in memory only. size is the bytes involved (0 when the target does not exist); omit it entirely for operations that only count calls, which then only get a count tree. */
export function trackAccess(config: { account: string; operation: string; path: string; size?: number }): void {
    let operations = accounts.get(config.account);
    if (!operations) {
        operations = new Map();
        accounts.set(config.account, operations);
    }
    let stats = operations.get(config.operation);
    if (!stats) {
        stats = { totalCount: 0, totalSize: 0, countTree: makeTree(() => 1) };
        operations.set(config.operation, stats);
    }
    let value: AccessValue = { path: config.path, size: config.size || 0 };
    stats.totalCount++;
    stats.countTree.add(value);
    if (config.size !== undefined) {
        let sizeTree = stats.sizeTree;
        if (!sizeTree) {
            sizeTree = makeTree(v => v.size);
            stats.sizeTree = sizeTree;
        }
        stats.totalSize += config.size;
        sizeTree.add(value);
    }
}

export function getAccessTotals(account: string): AccessTotals {
    let result: AccessTotals = {};
    let operations = accounts.get(account);
    if (!operations) return result;
    for (let [operation, stats] of operations) {
        result[operation] = { count: stats.totalCount, size: stats.totalSize };
    }
    return result;
}

export function readAccessSummaries(config: { account: string; operation: string; maxCount: number; weightBySize?: boolean }): SummaryEntry<AccessSummaryState>[] {
    let operations = accounts.get(config.account);
    let stats = operations && operations.get(config.operation);
    if (!stats) return [];
    // Count-only operations have no size tree, in which case weightBySize is ignored and the count breakdown is returned.
    let sizeTree = stats.sizeTree;
    if (config.weightBySize && sizeTree) {
        return sizeTree.getSummaries(config.maxCount);
    }
    return stats.countTree.getSummaries(config.maxCount);
}

export function clearAccountAccessStats(account: string): void {
    if (accounts.delete(account)) {
        console.log(`Cleared the in-memory access statistics for account ${account}`);
    }
}
