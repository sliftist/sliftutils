export type SummaryEntry<S> = {
    path: string;
    kind: "self" | "subtree" | "group" | "truncated";
    summary: S;
    weight: number;
};
export declare class TreeSummary<T, S> {
    private config;
    private root;
    private nodeCount;
    private maxTrackedNodes;
    constructor(config: {
        getPath: (value: T) => string;
        createSummary: () => S;
        addToSummary: (value: T, summary: S) => void;
        mergeSummaries: (target: S, source: S) => void;
        getWeight: (summary: S) => number;
        expectedOutputCount?: number;
    });
    add(value: T): void;
    private splitNode;
    getTrackedNodeCount(): number;
    getSummaries(maxCount: number): SummaryEntry<S>[];
    private isRefinable;
    private refine;
    private splitParts;
    private entryForParts;
    private subtreeEntry;
    private buildOutputSummary;
    private prune;
}
