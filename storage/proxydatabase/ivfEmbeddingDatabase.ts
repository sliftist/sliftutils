import cborx from "cbor-x";
import { Database, namespaceDatabase } from "./Database";
import { TransactionSetStore, transactionRead, transactionMutate, transactionDelete, replayTransactionStore } from "./transactionSet";
import { StoredEmbedding, EmbeddingFormat, getCloseness, embeddingToFloat32, releaseFloat32, encodeEmbedding, hashEmbedding } from "../embeddingFormats";

export type IvfConfig = {
    model: string;
    format: EmbeddingFormat;
    // Target number of embeddings per cell.
    cellTargetSize: number;
};

// Tiered storage. Below FLAT_LIMIT embeddings the whole set lives in one flat transaction set (no IVF);
// once it grows past that we build the IVF (centroids + per-cell sets) and stay there forever. `count` is
// the live embedding count (re-derived exactly on a rebuild). `steps` records one-time upgrades that must
// never re-run even if the set later shrinks and regrows.
export type IvfEmbeddingRoot = {
    config: IvfConfig;
    count: number;
    flat: TransactionSetStore<StoredEmbedding>;
    // Direct ref -> embedding index. Each entry is one CBOR blob at its own key, so a lookup or delete is a
    // single key-value op (no transaction-set replay) and deleteData can drop it (it's a primitive leaf). Refs
    // and their embeddings never move, so a rebuild leaves this untouched.
    byRef: { [ref: string]: Uint8Array };
    steps: { [step: string]: boolean };
    centroids: TransactionSetStore<StoredEmbedding>;
    cells: { [cellId: string]: TransactionSetStore<StoredEmbedding> };
};

export type EmbeddingInput = { ref: string; embedding: StoredEmbedding };
export type SearchHit = { ref: string; closeness: number };
type CellEntry = { ref: string; embedding: StoredEmbedding };

const embeddingCbor = new cborx.Encoder({ structuredClone: true });
function encodeRefValue(embedding: StoredEmbedding): Uint8Array {
    return embeddingCbor.encode(embedding) as Uint8Array;
}
function decodeRefValue(value: Uint8Array): StoredEmbedding {
    return embeddingCbor.decode(value) as StoredEmbedding;
}

// Below this many embeddings we skip the IVF entirely (flat store). 1024 = a clean power of two.
const FLAT_LIMIT = 1024;
// Force a from-scratch rebuild once at each of these (multiples of 4 above FLAT_LIMIT, up to ~16k), gated by a step flag so each runs at most once ever.
const REGENERATE_AT = [4096, 16384];
const STEP_IVF = "ivf";
// On delete, the member's exact cell plus this many nearby cells are checked, in case a rebuild left it non-optimal.
const DELETE_FALLBACK_CELLS = 10;
const REBALANCE_ITERATIONS = 4;

function flatStore(database: Database<IvfEmbeddingRoot>): Database<TransactionSetStore<StoredEmbedding>> {
    return namespaceDatabase(database, root => root.flat);
}
function centroidStore(database: Database<IvfEmbeddingRoot>): Database<TransactionSetStore<StoredEmbedding>> {
    return namespaceDatabase(database, root => root.centroids);
}
function cellStore(database: Database<IvfEmbeddingRoot>, cellId: string): Database<TransactionSetStore<StoredEmbedding>> {
    return namespaceDatabase(database, root => root.cells[cellId]);
}

function rankCellsByCloseness(embedding: StoredEmbedding, centroids: Map<string, StoredEmbedding>): string[] {
    const ranked: { cellId: string; closeness: number }[] = [];
    for (const cellId of centroids.keys()) {
        ranked.push({ cellId, closeness: getCloseness(embedding, centroids.get(cellId)!) });
    }
    ranked.sort((left, right) => right.closeness - left.closeness);
    return ranked.map(entry => entry.cellId);
}

// Per-write chance of a full rebuild. Zero at/under the target size, then rises (cubically) past it so cells
// stay roughly between target and ~2x target.
function rebalanceProbability(fillRatio: number): number {
    if (fillRatio <= 1) {
        return 0;
    }
    const over = fillRatio - 1;
    return Math.min(1, over * over * over * 0.25);
}

// k-means. Decodes every member to a pooled float32 buffer ONCE, then assigns with a plain internal float
// dot (no getCloseness call — comparing two float vectors is trivial) and keeps centroids as float means,
// encoding them to StoredEmbedding only at the end. Releases the borrowed buffers when done.
function clusterMembers(members: CellEntry[], clusterCount: number, config: IvfConfig): { centroid: StoredEmbedding; members: CellEntry[] }[] {
    const memberFloats: Float32Array[] = [];
    for (const member of members) {
        memberFloats.push(embeddingToFloat32(member.embedding, true));
    }
    const length = memberFloats.length ? memberFloats[0].length : 0;
    let centroids: Float32Array[] = [];
    const seedStep = members.length / clusterCount;
    for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex++) {
        centroids.push(new Float32Array(memberFloats[Math.floor(clusterIndex * seedStep)]));
    }
    let groups: number[][] = [];
    for (let iteration = 0; iteration < REBALANCE_ITERATIONS; iteration++) {
        groups = [];
        for (let clusterIndex = 0; clusterIndex < centroids.length; clusterIndex++) {
            groups.push([]);
        }
        for (let memberIndex = 0; memberIndex < memberFloats.length; memberIndex++) {
            const memberFloat = memberFloats[memberIndex];
            let bestIndex = 0;
            let bestDot = -Infinity;
            for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex++) {
                const centroidFloat = centroids[centroidIndex];
                let dot = 0;
                for (let dim = 0; dim < length; dim++) {
                    dot += memberFloat[dim] * centroidFloat[dim];
                }
                if (dot > bestDot) {
                    bestDot = dot;
                    bestIndex = centroidIndex;
                }
            }
            groups[bestIndex].push(memberIndex);
        }
        const nextCentroids: Float32Array[] = [];
        const nextGroups: number[][] = [];
        for (const group of groups) {
            if (!group.length) {
                continue;
            }
            const mean = new Float32Array(length);
            for (const memberIndex of group) {
                const memberFloat = memberFloats[memberIndex];
                for (let dim = 0; dim < length; dim++) {
                    mean[dim] += memberFloat[dim];
                }
            }
            let norm = 0;
            for (let dim = 0; dim < length; dim++) {
                norm += mean[dim] * mean[dim];
            }
            const magnitude = Math.sqrt(norm) || 1;
            for (let dim = 0; dim < length; dim++) {
                mean[dim] /= magnitude;
            }
            nextCentroids.push(mean);
            nextGroups.push(group);
        }
        centroids = nextCentroids;
        groups = nextGroups;
    }
    const result: { centroid: StoredEmbedding; members: CellEntry[] }[] = [];
    for (let clusterIndex = 0; clusterIndex < centroids.length; clusterIndex++) {
        const centroid = encodeEmbedding({ input: centroids[clusterIndex], format: config.format, model: config.model });
        const cellMembers: CellEntry[] = [];
        for (const memberIndex of groups[clusterIndex]) {
            cellMembers.push(members[memberIndex]);
        }
        result.push({ centroid, members: cellMembers });
    }
    for (const memberFloat of memberFloats) {
        releaseFloat32(memberFloat);
    }
    return result;
}

// Re-cluster EVERY embedding (flat tier + all cells) into a fresh IVF, clear the flat tier, and mark IVF
// mode. This is the rearranger: run probabilistically as the set grows, once at each regenerate threshold,
// and once to upgrade from flat. Reads everything it uses, so it bails (does nothing) if anything isn't
// synced and the caller's retry re-runs it; no caller cares about its result.
export function rebuildStructure(database: Database<IvfEmbeddingRoot>): void {
    const config = database.readData(root => root.config);
    if (!config) return;
    const steps = database.readData(root => root.steps);
    if (!steps) return;

    const allMembers: CellEntry[] = [];
    // Only the one-time flat->IVF upgrade pulls from the flat tier. Once STEP_IVF is set the flat data has
    // already been folded into cells, so later rebuilds ignore it. It's left in place, never deleted: deleteData
    // only removes primitive leaves, not a whole store, and the flat tier is small enough not to matter.
    if (!steps[STEP_IVF]) {
        const flat = transactionRead(flatStore(database));
        if (!flat) return;
        for (const ref of flat.keys()) {
            allMembers.push({ ref, embedding: flat.get(ref)! });
        }
    }
    const centroids = transactionRead(centroidStore(database));
    if (!centroids) return;
    const oldCellIds = Array.from(centroids.keys());
    const cellStores = database.readData(root => oldCellIds.map(cellId => root.cells[cellId]));
    if (!cellStores) return;
    for (const store of cellStores) {
        const members = replayTransactionStore<StoredEmbedding>(store);
        for (const ref of members.keys()) {
            allMembers.push({ ref, embedding: members.get(ref)! });
        }
    }
    if (!allMembers.length) return;

    const clusterCount = Math.max(1, Math.round(allMembers.length / config.cellTargetSize));
    const clusters = clusterMembers(allMembers, clusterCount, config);

    const newCellIds = new Set<string>();
    const centroidWrites: { key: string; value: StoredEmbedding | undefined }[] = [];
    for (const cluster of clusters) {
        const cellId = hashEmbedding(cluster.centroid);
        newCellIds.add(cellId);
        centroidWrites.push({ key: cellId, value: cluster.centroid });
        const memberWrites = cluster.members.map(member => ({ key: member.ref, value: member.embedding }));
        transactionMutate(cellStore(database, cellId), memberWrites);
    }
    for (const oldCellId of oldCellIds) {
        if (newCellIds.has(oldCellId)) {
            continue;
        }
        centroidWrites.push({ key: oldCellId, value: undefined });
        transactionDelete(cellStore(database, oldCellId));
    }
    transactionMutate(centroidStore(database), centroidWrites);
    database.writeData(root => root.count, allMembers.length);
    database.writeData(root => root.steps[STEP_IVF], true);
}

export function searchEmbeddings(
    database: Database<IvfEmbeddingRoot>,
    query: StoredEmbedding,
    options: { probeBudget: number; resultCount: number },
): SearchHit[] | undefined {
    const config = database.readData(root => root.config);
    if (!config) return undefined;
    const steps = database.readData(root => root.steps);
    if (!steps) return undefined;

    const hits: SearchHit[] = [];
    if (!steps[STEP_IVF]) {
        const flat = transactionRead(flatStore(database));
        if (!flat) return undefined;
        for (const ref of flat.keys()) {
            hits.push({ ref, closeness: getCloseness(query, flat.get(ref)!) });
        }
        hits.sort((left, right) => right.closeness - left.closeness);
        return hits.slice(0, options.resultCount);
    }

    const centroids = transactionRead(centroidStore(database));
    if (!centroids) return undefined;
    if (!centroids.size) return [];
    const probeCellCount = Math.max(1, Math.ceil(options.probeBudget / config.cellTargetSize));
    const probeCellIds = rankCellsByCloseness(query, centroids).slice(0, probeCellCount);
    const stores = database.readData(root => probeCellIds.map(cellId => root.cells[cellId]));
    if (!stores) return undefined;
    for (const store of stores) {
        const members = replayTransactionStore<StoredEmbedding>(store);
        for (const ref of members.keys()) {
            hits.push({ ref, closeness: getCloseness(query, members.get(ref)!) });
        }
    }
    hits.sort((left, right) => right.closeness - left.closeness);
    return hits.slice(0, options.resultCount);
}

// Direct ref -> stored embedding lookup through the byRef index: one key-value read per ref, no cell scan. A
// search returns refs; this fetches the data behind them. Skips refs that aren't present; undefined if not synced.
export function lookupEmbeddings(
    database: Database<IvfEmbeddingRoot>,
    refs: string[],
): Map<string, StoredEmbedding> | undefined {
    const values = database.readData(root => refs.map(ref => root.byRef[ref]));
    if (!values) return undefined;
    const result = new Map<string, StoredEmbedding>();
    for (let index = 0; index < refs.length; index++) {
        const value = values[index];
        if (value) {
            result.set(refs[index], decodeRefValue(value));
        }
    }
    return result;
}

export function insertEmbeddings(
    database: Database<IvfEmbeddingRoot>,
    items: EmbeddingInput[],
) {
    if (!items.length) return;
    const config = database.readData(root => root.config);
    const steps = database.readData(root => root.steps);
    let count = database.readData(root => root.count);
    if (!config) return;
    if (!steps) return;
    if (count === undefined) return;
    const newCount = count + items.length;

    if (!steps[STEP_IVF]) {
        const flatWrites = items.map(item => ({ key: item.ref, value: item.embedding }));
        transactionMutate(flatStore(database), flatWrites);
        for (const item of items) {
            database.writeData(root => root.byRef[item.ref], encodeRefValue(item.embedding));
        }
        database.writeData(root => root.count, newCount);
        if (newCount > FLAT_LIMIT) {
            rebuildStructure(database);
        }
        return;
    }

    const centroids = transactionRead(centroidStore(database));
    if (!centroids) return undefined;
    const itemsByCell = new Map<string, EmbeddingInput[]>();
    for (const item of items) {
        const cellId = rankCellsByCloseness(item.embedding, centroids)[0];
        let group = itemsByCell.get(cellId);
        if (!group) {
            group = [];
            itemsByCell.set(cellId, group);
        }
        group.push(item);
    }
    for (const cellId of itemsByCell.keys()) {
        const group = itemsByCell.get(cellId)!;
        const memberWrites = group.map(item => ({ key: item.ref, value: item.embedding }));
        transactionMutate(cellStore(database, cellId), memberWrites);
    }
    for (const item of items) {
        database.writeData(root => root.byRef[item.ref], encodeRefValue(item.embedding));
    }
    database.writeData(root => root.count, newCount);


    const shouldRegenerate = (database: Database<IvfEmbeddingRoot>) => {
        let steps = database.readData(root => root.steps);
        if (!steps) return;
        for (const threshold of REGENERATE_AT) {
            const stepName = "regen" + threshold;
            if (!steps[stepName] && newCount > threshold) {
                database.writeData(root => root.steps[stepName], true);
                return true;
            }
        }
        const averageFill = newCount / Math.max(1, centroids.size) / config.cellTargetSize;
        if (Math.random() < rebalanceProbability(averageFill)) {
            rebuildStructure(database);
        }
        return true;
    };
    if (shouldRegenerate(database)) {
        rebuildStructure(database);
    }
}

export function removeEmbeddings(
    database: Database<IvfEmbeddingRoot>,
    refs: string[],
) {
    if (!refs.length) return;
    const steps = database.readData(root => root.steps);
    const count = database.readData(root => root.count);
    if (!steps) return;
    if (count === undefined) return;

    if (!steps[STEP_IVF]) {
        const flatDeletes = refs.map(ref => ({ key: ref, value: undefined }));
        transactionMutate(flatStore(database), flatDeletes);
        for (const ref of refs) {
            database.deleteData(root => root.byRef[ref]);
        }
        database.writeData(root => root.count, Math.max(0, count - refs.length));
        return;
    }

    const centroids = transactionRead(centroidStore(database));
    if (!centroids) return;
    if (!centroids.size) return;

    // Look up each ref's embedding through byRef, then rank its cells the way an insert would, so we delete from
    // the cell it actually landed in (plus a few neighbours, in case a rebuild nudged it across a boundary).
    const refValues = database.readData(root => refs.map(ref => root.byRef[ref]));
    if (!refValues) return;
    const candidatesByItem: { ref: string; cellIds: string[] }[] = [];
    const candidateSet = new Set<string>();
    for (let index = 0; index < refs.length; index++) {
        const value = refValues[index];
        if (!value) {
            continue;
        }
        const embedding = decodeRefValue(value);
        const cellIds = rankCellsByCloseness(embedding, centroids).slice(0, 1 + DELETE_FALLBACK_CELLS);
        candidatesByItem.push({ ref: refs[index], cellIds });
        for (const cellId of cellIds) {
            candidateSet.add(cellId);
        }
    }

    const candidateCellIds = Array.from(candidateSet);
    const stores = database.readData(root => candidateCellIds.map(cellId => root.cells[cellId]));
    if (!stores) return;
    const membersByCell = new Map<string, Map<string, StoredEmbedding>>();
    for (let index = 0; index < candidateCellIds.length; index++) {
        membersByCell.set(candidateCellIds[index], replayTransactionStore(stores[index]));
    }

    const deletesByCell = new Map<string, string[]>();
    const deletedRefs: string[] = [];
    for (const candidate of candidatesByItem) {
        for (const cellId of candidate.cellIds) {
            const members = membersByCell.get(cellId);
            if (!members || !members.has(candidate.ref)) {
                continue;
            }
            let cellRefs = deletesByCell.get(cellId);
            if (!cellRefs) {
                cellRefs = [];
                deletesByCell.set(cellId, cellRefs);
            }
            cellRefs.push(candidate.ref);
            deletedRefs.push(candidate.ref);
            break;
        }
    }

    for (const cellId of deletesByCell.keys()) {
        const cellRefs = deletesByCell.get(cellId)!;
        const memberDeletes = cellRefs.map(ref => ({ key: ref, value: undefined }));
        transactionMutate(cellStore(database, cellId), memberDeletes);
    }
    for (const ref of deletedRefs) {
        database.deleteData(root => root.byRef[ref]);
    }
    if (deletedRefs.length) {
        database.writeData(root => root.count, Math.max(0, count - deletedRefs.length));
    }
}
