import { Database, namespaceDatabase } from "./Database";
import { TransactionSetStore, transactionRead, transactionMutate, replayTransactionStore } from "./transactionSet";
import { StoredEmbedding, EmbeddingFormat, getCloseness, averageEmbeddings, hashEmbedding } from "../embeddingFormats";

export type IvfConfig = {
    model: string;
    format: EmbeddingFormat;
    // Target number of embeddings per cell.
    cellTargetSize: number;
};

// Cell ids ARE the hash of the cell's centroid, so there's no id counter. centroids maps that id to the
// centroid embedding (read whole as the preload, ranked in RAM). Each cell is its own transaction set of
// ref => member embedding. There is no ref index: a rebalance keeps every member in (or very near) its
// optimal cell, so a delete finds a member by closeness instead.
export type IvfEmbeddingRoot = {
    config: IvfConfig;
    centroids: TransactionSetStore<StoredEmbedding>;
    cells: { [cellId: string]: TransactionSetStore<StoredEmbedding> };
};

export type EmbeddingInput = { ref: string; embedding: StoredEmbedding };
export type SearchHit = { ref: string; closeness: number };

type CellEntry = { ref: string; embedding: StoredEmbedding };

// On a delete, the member's exact cell plus this many nearby cells are checked, in case a rebalance left
// it in a non-optimal cell.
const DELETE_FALLBACK_CELLS = 10;
// How hard the rebalance k-means works. A rebalance reads + reclusters everything, so this is kept small.
const REBALANCE_ITERATIONS = 4;

function centroidStore(database: Database<IvfEmbeddingRoot>): Database<TransactionSetStore<StoredEmbedding>> {
    return namespaceDatabase(database, root => root.centroids);
}
function cellStore(database: Database<IvfEmbeddingRoot>, cellId: string): Database<TransactionSetStore<StoredEmbedding>> {
    return namespaceDatabase(database, root => root.cells[cellId]);
}

function rankCellsByCloseness(embedding: StoredEmbedding, centroids: Map<string, StoredEmbedding>): string[] {
    const ranked: { cellId: string; closeness: number }[] = [];
    centroids.forEach((centroid, cellId) => {
        ranked.push({ cellId, closeness: getCloseness(embedding, centroid) });
    });
    ranked.sort((left, right) => right.closeness - left.closeness);
    return ranked.map(entry => entry.cellId);
}

// Per-write chance of a full rebalance. Zero at/under the target size; rises gently to ~0.25 by 2x the
// target, then accelerates toward 1 beyond that — so cells are kept between target and ~2x target size.
function rebalanceProbability(fillRatio: number): number {
    if (fillRatio <= 1) {
        return 0;
    }
    const over = fillRatio - 1;
    return Math.min(1, over * over * over * 0.25);
}

// k-means over every member, into ~members/cellTargetSize clusters. getCloseness decodes both embeddings
// per call, so this is the expensive part of a rebalance (kept rare by rebalanceProbability).
function clusterMembers(members: CellEntry[], clusterCount: number, config: IvfConfig): { centroid: StoredEmbedding; members: CellEntry[] }[] {
    let centroids: StoredEmbedding[] = [];
    const seedStep = members.length / clusterCount;
    for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex++) {
        centroids.push(members[Math.floor(clusterIndex * seedStep)].embedding);
    }
    let groups: CellEntry[][] = [];
    for (let iteration = 0; iteration < REBALANCE_ITERATIONS; iteration++) {
        groups = centroids.map(() => []);
        for (const member of members) {
            let bestIndex = 0;
            let bestCloseness = -Infinity;
            for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex++) {
                const closeness = getCloseness(member.embedding, centroids[centroidIndex]);
                if (closeness > bestCloseness) {
                    bestCloseness = closeness;
                    bestIndex = centroidIndex;
                }
            }
            groups[bestIndex].push(member);
        }
        const nextCentroids: StoredEmbedding[] = [];
        const nextGroups: CellEntry[][] = [];
        for (const group of groups) {
            if (!group.length) {
                continue;
            }
            nextCentroids.push(averageEmbeddings(group.map(member => member.embedding), config));
            nextGroups.push(group);
        }
        centroids = nextCentroids;
        groups = nextGroups;
    }
    const result: { centroid: StoredEmbedding; members: CellEntry[] }[] = [];
    for (let clusterIndex = 0; clusterIndex < groups.length; clusterIndex++) {
        result.push({ centroid: centroids[clusterIndex], members: groups[clusterIndex] });
    }
    return result;
}

// Re-cluster the WHOLE index so cells are ~cellTargetSize again. Reads every cell at once, reclusters,
// writes the new cells + centroids and drops the old ones. Safe to run concurrently — two writers just
// contend and the last write wins. undefined while not synced.
export function rebalanceIvf(database: Database<IvfEmbeddingRoot>): true | undefined {
    const config = database.readData(root => root.config);
    if (!config) return undefined;
    const centroids = transactionRead(centroidStore(database));
    if (!centroids) return undefined;
    if (!centroids.size) return true;

    const oldCellIds = [...centroids.keys()];
    const stores = database.readData(root => oldCellIds.map(cellId => root.cells[cellId]));
    if (!stores) return undefined;

    const allMembers: CellEntry[] = [];
    for (const store of stores) {
        replayTransactionStore(store).forEach((embedding, ref) => {
            allMembers.push({ ref, embedding });
        });
    }
    if (!allMembers.length) return true;

    const clusterCount = Math.max(1, Math.round(allMembers.length / config.cellTargetSize));
    const clusters = clusterMembers(allMembers, clusterCount, config);

    const newCellIds = new Set<string>();
    const centroidWrites: { key: string; value: StoredEmbedding | undefined }[] = [];
    for (const cluster of clusters) {
        const cellId = hashEmbedding(cluster.centroid);
        newCellIds.add(cellId);
        centroidWrites.push({ key: cellId, value: cluster.centroid });
        const memberWrites = cluster.members.map(member => ({ key: member.ref, value: member.embedding }));
        if (!transactionMutate(cellStore(database, cellId), memberWrites)) return undefined;
    }
    for (const oldCellId of oldCellIds) {
        if (newCellIds.has(oldCellId)) {
            continue;
        }
        centroidWrites.push({ key: oldCellId, value: undefined });
        database.deleteData(root => root.cells[oldCellId]);
    }
    if (!transactionMutate(centroidStore(database), centroidWrites)) return undefined;
    return true;
}

// Nearest cells until probeBudget members are covered, scored exactly against the query. undefined while
// not synced. All probed cells are fetched in one batched read so probing doesn't cascade per cell.
export function searchEmbeddings(
    database: Database<IvfEmbeddingRoot>,
    query: StoredEmbedding,
    options: { probeBudget: number; resultCount: number },
): SearchHit[] | undefined {
    const config = database.readData(root => root.config);
    if (!config) return undefined;
    const centroids = transactionRead(centroidStore(database));
    if (!centroids) return undefined;
    if (!centroids.size) return [];

    const probeCellCount = Math.max(1, Math.ceil(options.probeBudget / config.cellTargetSize));
    const probeCellIds = rankCellsByCloseness(query, centroids).slice(0, probeCellCount);
    const stores = database.readData(root => probeCellIds.map(cellId => root.cells[cellId]));
    if (!stores) return undefined;

    const hits: SearchHit[] = [];
    for (const store of stores) {
        replayTransactionStore(store).forEach((embedding, ref) => {
            hits.push({ ref, closeness: getCloseness(query, embedding) });
        });
    }
    hits.sort((left, right) => right.closeness - left.closeness);
    return hits.slice(0, options.resultCount);
}

// Add each embedding to its nearest cell (bootstrapping a first cell on an empty index), then with a
// fill-dependent probability run a full rebalance to keep cells near the target size. undefined while not
// synced.
export function insertEmbeddings(
    database: Database<IvfEmbeddingRoot>,
    items: EmbeddingInput[],
): true | undefined {
    if (!items.length) return true;
    const config = database.readData(root => root.config);
    if (!config) return undefined;
    const centroids = transactionRead(centroidStore(database));
    if (!centroids) return undefined;

    const newCentroids: { key: string; value: StoredEmbedding }[] = [];
    if (!centroids.size) {
        const centroid = averageEmbeddings(items.map(item => item.embedding), config);
        const cellId = hashEmbedding(centroid);
        centroids.set(cellId, centroid);
        newCentroids.push({ key: cellId, value: centroid });
    }

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

    const targetCellIds = [...itemsByCell.keys()];
    const existingStores = database.readData(root => targetCellIds.map(cellId => root.cells[cellId]));
    if (!existingStores) return undefined;

    let maxFillRatio = 0;
    for (let cellIndex = 0; cellIndex < targetCellIds.length; cellIndex++) {
        const cellId = targetCellIds[cellIndex];
        const group = itemsByCell.get(cellId)!;
        const existingSize = replayTransactionStore(existingStores[cellIndex]).size;
        maxFillRatio = Math.max(maxFillRatio, (existingSize + group.length) / config.cellTargetSize);
        const memberWrites = group.map(item => ({ key: item.ref, value: item.embedding }));
        if (!transactionMutate(cellStore(database, cellId), memberWrites)) return undefined;
    }
    if (newCentroids.length && !transactionMutate(centroidStore(database), newCentroids)) return undefined;

    if (Math.random() < rebalanceProbability(maxFillRatio)) {
        rebalanceIvf(database);
    }
    return true;
}

// Delete each member from the cell it should be in (nearest centroid), falling back to a few nearby cells
// in case a rebalance left it elsewhere. Needs the embedding to locate the cell. undefined while not synced.
export function removeEmbeddings(
    database: Database<IvfEmbeddingRoot>,
    items: EmbeddingInput[],
): true | undefined {
    if (!items.length) return true;
    const centroids = transactionRead(centroidStore(database));
    if (!centroids) return undefined;
    if (!centroids.size) return true;

    const candidatesByItem: { ref: string; cellIds: string[] }[] = [];
    const candidateSet = new Set<string>();
    for (const item of items) {
        const cellIds = rankCellsByCloseness(item.embedding, centroids).slice(0, 1 + DELETE_FALLBACK_CELLS);
        candidatesByItem.push({ ref: item.ref, cellIds });
        for (const cellId of cellIds) {
            candidateSet.add(cellId);
        }
    }

    const candidateCellIds = [...candidateSet];
    const stores = database.readData(root => candidateCellIds.map(cellId => root.cells[cellId]));
    if (!stores) return undefined;
    const membersByCell = new Map<string, Map<string, StoredEmbedding>>();
    for (let cellIndex = 0; cellIndex < candidateCellIds.length; cellIndex++) {
        membersByCell.set(candidateCellIds[cellIndex], replayTransactionStore(stores[cellIndex]));
    }

    const deletesByCell = new Map<string, string[]>();
    for (const candidate of candidatesByItem) {
        for (const cellId of candidate.cellIds) {
            const members = membersByCell.get(cellId);
            if (!members || !members.has(candidate.ref)) {
                continue;
            }
            let refs = deletesByCell.get(cellId);
            if (!refs) {
                refs = [];
                deletesByCell.set(cellId, refs);
            }
            refs.push(candidate.ref);
            break;
        }
    }

    for (const cellId of deletesByCell.keys()) {
        const refs = deletesByCell.get(cellId)!;
        const memberDeletes = refs.map(ref => ({ key: ref, value: undefined }));
        if (!transactionMutate(cellStore(database, cellId), memberDeletes)) return undefined;
    }
    return true;
}
