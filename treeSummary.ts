import { sort } from "socket-function/src/misc";

const DEFAULT_OUTPUT_COUNT = 100;
const TRACKED_NODES_PER_OUTPUT = 100;
const MIN_TRACKED_NODES = 1_000;
const MAX_TRACKED_NODES = 10_000;
const PRUNE_TARGET_DIVISOR = 2;
const PRUNE_SEARCH_ITERATIONS = 20;

type TreeNode<S> = {
    // The path fragment this node covers, i.e. the edge from its parent. Children are keyed by the first character of their label.
    label: string;
    children: Map<string, TreeNode<S>>;
    // Aggregate of every value whose path passes through (or ends at) this node.
    summary: S;
    // Aggregate of only the values whose path ends exactly at this node.
    selfSummary?: S;
    // Aggregate of values that were below this node before pruning collapsed their branches. Their path detail is gone, but their data is preserved.
    truncatedSummary?: S;
};

export type SummaryEntry<S> = {
    // Ends with "*" unless the entry is a single exact path that was heavy enough to stand on its own.
    path: string;
    // "self" = values whose path is exactly path. "subtree" = every value whose path starts with path. "group" = values under path kept combined (light sibling branches, chain leftovers, or both) because none was heavy enough to deserve its own entry. "truncated" = values under path whose detail was pruned away.
    kind: "self" | "subtree" | "group" | "truncated";
    summary: S;
    weight: number;
};

type PendingEntry<S> = {
    kind: "self" | "subtree" | "group" | "truncated";
    path: string;
    node?: TreeNode<S>;
    // Where node actually sits when path compression descended a single-child chain past carried residues; equals path when no residues were carried.
    nodePath?: string;
    members?: Map<string, TreeNode<S>>;
    // Self/truncated summaries that sit between path and node (for "subtree"), or the loose summaries of a combined entry (for "group"/"truncated").
    extras?: S[];
    weight: number;
};

type NodeStats = {
    size: number;
    weight: number;
};

export class TreeSummary<T, S> {
    private root: TreeNode<S>;
    private nodeCount = 1;
    private maxTrackedNodes: number;

    constructor(private config: {
        getPath: (value: T) => string;
        createSummary: () => S;
        addToSummary: (value: T, summary: S) => void;
        mergeSummaries: (target: S, source: S) => void;
        getWeight: (summary: S) => number;
        // Sizes the internal tree, which keeps roughly TRACKED_NODES_PER_OUTPUT times this many nodes so output granularity decisions have detail to work with.
        expectedOutputCount?: number;
    }) {
        this.root = { label: "", children: new Map(), summary: config.createSummary() };
        let outputCount = config.expectedOutputCount || DEFAULT_OUTPUT_COUNT;
        this.maxTrackedNodes = Math.min(Math.max(outputCount * TRACKED_NODES_PER_OUTPUT, MIN_TRACKED_NODES), MAX_TRACKED_NODES);
    }

    public add(value: T) {
        let path = this.config.getPath(value);
        let node = this.root;
        this.config.addToSummary(value, node.summary);
        let pos = 0;
        while (pos < path.length) {
            let child = node.children.get(path[pos]);
            if (!child) {
                child = { label: path.slice(pos), children: new Map(), summary: this.config.createSummary() };
                node.children.set(path[pos], child);
                this.nodeCount++;
                this.config.addToSummary(value, child.summary);
                node = child;
                break;
            }
            let label = child.label;
            let limit = Math.min(label.length, path.length - pos);
            let common = 1;
            while (common < limit && label.charCodeAt(common) === path.charCodeAt(pos + common)) {
                common++;
            }
            if (common < label.length) {
                this.splitNode(child, common);
            }
            this.config.addToSummary(value, child.summary);
            node = child;
            pos += common;
        }
        let selfSummary = node.selfSummary;
        if (!selfSummary) {
            selfSummary = this.config.createSummary();
            node.selfSummary = selfSummary;
        }
        this.config.addToSummary(value, selfSummary);
        if (this.nodeCount > this.maxTrackedNodes) {
            this.prune();
        }
    }

    // Splits a node's edge label at labelPos, inserting a new parent covering the prefix. The prefix node's summary is a merge-clone of the original aggregate, since it covers the exact same set of values.
    private splitNode(node: TreeNode<S>, labelPos: number) {
        let suffix: TreeNode<S> = {
            label: node.label.slice(labelPos),
            children: node.children,
            summary: node.summary,
            selfSummary: node.selfSummary,
            truncatedSummary: node.truncatedSummary,
        };
        let prefixSummary = this.config.createSummary();
        this.config.mergeSummaries(prefixSummary, suffix.summary);
        node.label = node.label.slice(0, labelPos);
        node.summary = prefixSummary;
        node.selfSummary = undefined;
        node.truncatedSummary = undefined;
        node.children = new Map([[suffix.label[0], suffix]]);
        this.nodeCount++;
    }

    public getTrackedNodeCount(): number {
        return this.nodeCount;
    }

    // Starts fully collapsed (one entry for the whole tree) and repeatedly refines the heaviest entry, one split at a time. A split pulls the heaviest branch out as its own entry and leaves the remaining siblings combined in a group entry, so entries are never wasted on light branches. This recomputes from the live per-node summaries, so it always reflects everything added so far.
    public getSummaries(maxCount: number): SummaryEntry<S>[] {
        if (maxCount <= 0) {
            throw new Error(`maxCount must be positive, was ${maxCount}`);
        }
        if (!this.root.selfSummary && !this.root.truncatedSummary && this.root.children.size === 0) {
            return [];
        }
        let entries: PendingEntry<S>[] = [this.subtreeEntry(this.root, "")];
        while (entries.length < maxCount) {
            let bestIndex = -1;
            for (let i = 0; i < entries.length; i++) {
                if (!this.isRefinable(entries[i])) continue;
                if (bestIndex === -1 || entries[i].weight > entries[bestIndex].weight) {
                    bestIndex = i;
                }
            }
            if (bestIndex === -1) break;
            let refined = this.refine(entries[bestIndex]);
            entries.splice(bestIndex, 1, ...refined);
        }
        let output = entries.map(entry => {
            let path = entry.path;
            if (entry.kind !== "self") {
                path += "*";
            }
            return {
                path,
                kind: entry.kind,
                summary: this.buildOutputSummary(entry),
                weight: entry.weight,
            };
        });
        sort(output, entry => entry.path);
        return output;
    }

    private isRefinable(entry: PendingEntry<S>): boolean {
        if (entry.kind === "self" || entry.kind === "truncated") return false;
        if (entry.kind === "group") {
            let members = entry.members;
            if (!members || members.size === 0) return false;
            return members.size + (entry.extras && entry.extras.length || 0) >= 2;
        }
        let node = entry.node;
        if (!node) return false;
        if (entry.extras && entry.extras.length > 0) return true;
        let parts = node.children.size + (node.selfSummary && 1 || 0) + (node.truncatedSummary && 1 || 0);
        return parts >= 2;
    }

    // Replaces one entry with exactly two, so each refinement costs exactly one output slot.
    private refine(entry: PendingEntry<S>): PendingEntry<S>[] {
        if (entry.kind === "group") {
            let members = entry.members;
            if (!members) {
                throw new Error(`Group entry missing members at ${entry.path}`);
            }
            return this.splitParts(members, entry.extras || [], entry.path);
        }
        let node = entry.node;
        if (entry.kind !== "subtree" || !node) {
            throw new Error(`Entry is not refinable at ${entry.path}`);
        }
        let extras = entry.extras;
        if (extras && extras.length > 0) {
            // Split off the chain residues as one combined entry, so a long chain of pruning leftovers costs a single slot instead of one per character.
            let weight = 0;
            for (let extra of extras) {
                weight += this.config.getWeight(extra);
            }
            return [
                { kind: "group", path: entry.path, extras, weight },
                this.subtreeEntry(node, entry.nodePath || entry.path),
            ];
        }
        // Children live below the node, so their paths must extend nodePath, never the (possibly shorter) display path.
        let nodePath = entry.nodePath || entry.path;
        let truncatedList: S[] = [];
        if (node.truncatedSummary) {
            truncatedList.push(node.truncatedSummary);
        }
        let selfSummary = node.selfSummary;
        if (selfSummary) {
            return [
                { kind: "self", path: nodePath, node, weight: this.config.getWeight(selfSummary) },
                this.entryForParts(node.children, truncatedList, nodePath),
            ];
        }
        return this.splitParts(node.children, truncatedList, nodePath);
    }

    private splitParts(children: Map<string, TreeNode<S>>, extras: S[], path: string): PendingEntry<S>[] {
        let heaviestChar = "";
        let heaviest: TreeNode<S> | undefined;
        for (let [char, child] of children) {
            if (!heaviest || this.config.getWeight(child.summary) > this.config.getWeight(heaviest.summary)) {
                heaviestChar = char;
                heaviest = child;
            }
        }
        if (!heaviest) {
            throw new Error(`Cannot split empty child set at ${path}`);
        }
        let rest = new Map(children);
        rest.delete(heaviestChar);
        return [
            this.subtreeEntry(heaviest, path + heaviest.label),
            this.entryForParts(rest, extras, path),
        ];
    }

    private entryForParts(children: Map<string, TreeNode<S>>, extras: S[], path: string): PendingEntry<S> {
        if (children.size === 0) {
            if (extras.length === 0) {
                throw new Error(`No parts to make an entry from at ${path}`);
            }
            let weight = 0;
            for (let extra of extras) {
                weight += this.config.getWeight(extra);
            }
            return { kind: "truncated", path, extras, weight };
        }
        if (children.size === 1 && extras.length === 0) {
            for (let child of children.values()) {
                return this.subtreeEntry(child, path + child.label);
            }
        }
        let weight = 0;
        for (let extra of extras) {
            weight += this.config.getWeight(extra);
        }
        for (let child of children.values()) {
            weight += this.config.getWeight(child.summary);
        }
        return { kind: "group", path, members: children, extras, weight };
    }

    private subtreeEntry(node: TreeNode<S>, path: string): PendingEntry<S> {
        // Follow single-child chains so paths are maximal shared prefixes instead of single characters. Self/truncated summaries found along the chain are carried on the entry instead of stopping the descent, so pruning leftovers scattered along a chain end up combined instead of each forcing an entry.
        let carried: S[] = [];
        let carriedWeight = 0;
        let nodePath = path;
        while (node.children.size === 1) {
            let selfSummary = node.selfSummary;
            if (selfSummary) {
                carried.push(selfSummary);
                carriedWeight += this.config.getWeight(selfSummary);
            }
            let truncated = node.truncatedSummary;
            if (truncated) {
                carried.push(truncated);
                carriedWeight += this.config.getWeight(truncated);
            }
            for (let child of node.children.values()) {
                nodePath += child.label;
                node = child;
            }
        }
        // With nothing carried the entry is just the deep node, so display the full descended prefix.
        if (carried.length === 0) {
            path = nodePath;
        }
        return {
            kind: "subtree",
            path,
            node,
            nodePath,
            extras: carried,
            weight: this.config.getWeight(node.summary) + carriedWeight,
        };
    }

    private buildOutputSummary(entry: PendingEntry<S>): S {
        let result = this.config.createSummary();
        if (entry.kind === "group" || entry.kind === "truncated") {
            for (let extra of entry.extras || []) {
                this.config.mergeSummaries(result, extra);
            }
            if (entry.members) {
                for (let member of entry.members.values()) {
                    this.config.mergeSummaries(result, member.summary);
                }
            }
            return result;
        }
        let node = entry.node;
        if (!node) {
            throw new Error(`Entry missing node at ${entry.path}`);
        }
        if (entry.kind === "self") {
            let selfSummary = node.selfSummary;
            if (!selfSummary) {
                throw new Error(`Self entry missing selfSummary at ${entry.path}`);
            }
            this.config.mergeSummaries(result, selfSummary);
            return result;
        }
        for (let extra of entry.extras || []) {
            this.config.mergeSummaries(result, extra);
        }
        this.config.mergeSummaries(result, node.summary);
        return result;
    }

    // Collapses the lightest subtrees until the node count is back under the target. Collapsing a node merges everything below it into its truncatedSummary, keeping the data but dropping the path detail. If those prefixes get heavy again later, new adds rebuild branches there and the next prune takes out whatever stayed light instead.
    private prune() {
        let target = Math.floor(this.maxTrackedNodes / PRUNE_TARGET_DIVISOR);
        let need = this.nodeCount - target;
        if (need <= 0) return;
        let stats = new Map<TreeNode<S>, NodeStats>();
        let measure = (node: TreeNode<S>): NodeStats => {
            let size = 1;
            for (let child of node.children.values()) {
                size += measure(child).size;
            }
            let result = { size, weight: this.config.getWeight(node.summary) };
            stats.set(node, result);
            return result;
        };
        let rootStats = measure(this.root);
        let getStats = (node: TreeNode<S>): NodeStats => {
            let stat = stats.get(node);
            if (!stat) {
                throw new Error(`Missing node stats during prune`);
            }
            return stat;
        };
        // Collapsing every maximal subtree whose weight is under a limit frees a monotonically increasing number of nodes, so binary search for the smallest limit that frees enough.
        let freedAt = (limit: number): number => {
            let freed = 0;
            let visit = (node: TreeNode<S>) => {
                if (node.children.size === 0) return;
                if (getStats(node).weight <= limit) {
                    freed += getStats(node).size - 1;
                    return;
                }
                for (let child of node.children.values()) {
                    visit(child);
                }
            };
            visit(this.root);
            return freed;
        };
        let low = 0;
        let high = rootStats.weight;
        for (let i = 0; i < PRUNE_SEARCH_ITERATIONS; i++) {
            let mid = (low + high) / 2;
            if (freedAt(mid) >= need) {
                high = mid;
            } else {
                low = mid;
            }
        }
        let collapseVisit = (node: TreeNode<S>) => {
            if (node.children.size === 0) return;
            if (getStats(node).weight <= high) {
                let truncated = node.truncatedSummary;
                if (!truncated) {
                    truncated = this.config.createSummary();
                    node.truncatedSummary = truncated;
                }
                for (let child of node.children.values()) {
                    this.config.mergeSummaries(truncated, child.summary);
                }
                this.nodeCount -= getStats(node).size - 1;
                node.children.clear();
                return;
            }
            for (let child of node.children.values()) {
                collapseVisit(child);
            }
        };
        collapseVisit(this.root);
    }
}
