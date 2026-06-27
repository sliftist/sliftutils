import { Database, namespaceDatabase } from "./Database";
import { TransactionSetStore, transactionRead, transactionMutate, replayTransactionStore } from "./transactionSet";
import { StoredEmbedding, EmbeddingFormat, getCloseness, averageEmbeddings, hashEmbedding } from "../embeddingFormats";

export type IvfConfig = {
    model: string;
    format: EmbeddingFormat;
    cellTarget: number;
    splitAt: number;
};

// Cell ids ARE the hash of the cell's centroid, so there's no id counter. centroids maps that id to the
// centroid embedding (read whole as the preload, ranked in RAM). Each cell is its own transaction set of
// ref → member embedding. refIndex maps a ref to the cell holding it, so a remove can find it.
export type IvfEmbeddingRoot = {
    config: IvfConfig;
    centroids: TransactionSetStore;
    cells: { [cellId: string]: TransactionSetStore };
    refIndex: TransactionSetStore;
};

export type EmbeddingInput = { ref: string; embedding: StoredEmbedding };
export type SearchHit = { ref: string; closeness: number };

function centroidStore(database: Database<IvfEmbeddingRoot>): Database<TransactionSetStore> {
    return namespaceDatabase(database, root => root.centroids);
}
function cellStore(database: Database<IvfEmbeddingRoot>, cellId: string): Database<TransactionSetStore> {
    return namespaceDatabase(database, root => root.cells[cellId]);
}
function refIndexStore(database: Database<IvfEmbeddingRoot>): Database<TransactionSetStore> {
    return namespaceDatabase(database, root => root.refIndex);
}

function nearestCell(embedding: StoredEmbedding, centroids: Map<string, StoredEmbedding>): string {
    let bestCellId = "";
    let bestCloseness = -Infinity;
    for (const [cellId, centroid] of centroids) {
        const closeness = getCloseness(embedding, centroid);
        if (closeness > bestCloseness) {
            bestCloseness = closeness;
            bestCellId = cellId;
        }
    }
    return bestCellId;
}

// 2-means on a cell's members so an overgrown cell can split in place. Seeds with one member and the one
// farthest from it, then alternates assign / recompute-centroid a few times.
function splitInTwo(
    members: [string, StoredEmbedding][],
    config: IvfConfig,
): { centroid: StoredEmbedding; members: [string, StoredEmbedding][] }[] {
    let centroidA = members[0][1];
    let centroidB = members[0][1];
    let worst = Infinity;
    for (const [, embedding] of members) {
        const closeness = getCloseness(centroidA, embedding);
        if (closeness < worst) {
            worst = closeness;
            centroidB = embedding;
        }
    }
    let groupA: [string, StoredEmbedding][] = [];
    let groupB: [string, StoredEmbedding][] = [];
    for (let iteration = 0; iteration < 5; iteration++) {
        groupA = [];
        groupB = [];
        for (const member of members) {
            if (getCloseness(centroidA, member[1]) >= getCloseness(centroidB, member[1])) {
                groupA.push(member);
            } else {
                groupB.push(member);
            }
        }
        if (!groupA.length || !groupB.length) {
            break;
        }
        centroidA = averageEmbeddings(groupA.map(member => member[1]), config);
        centroidB = averageEmbeddings(groupB.map(member => member[1]), config);
    }
    const result: { centroid: StoredEmbedding; members: [string, StoredEmbedding][] }[] = [];
    if (groupA.length) {
        result.push({ centroid: centroidA, members: groupA });
    }
    if (groupB.length) {
        result.push({ centroid: centroidB, members: groupB });
    }
    return result;
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
    const centroids = transactionRead<StoredEmbedding>(centroidStore(database));
    if (!centroids) return undefined;
    if (!centroids.size) return [];

    const rankedCellIds = [...centroids.entries()]
        .map(([cellId, centroid]) => ({ cellId, closeness: getCloseness(query, centroid) }))
        .sort((left, right) => right.closeness - left.closeness)
        .map(ranked => ranked.cellId);

    const probeCellCount = Math.max(1, Math.ceil(options.probeBudget / config.cellTarget));
    const probeCellIds = rankedCellIds.slice(0, probeCellCount);
    const stores = database.readData(root => probeCellIds.map(cellId => root.cells[cellId]));
    if (!stores) return undefined;

    const hits: SearchHit[] = [];
    for (const store of stores) {
        const members = replayTransactionStore<StoredEmbedding>(store);
        for (const [ref, embedding] of members) {
            hits.push({ ref, closeness: getCloseness(query, embedding) });
        }
    }
    hits.sort((left, right) => right.closeness - left.closeness);
    return hits.slice(0, options.resultCount);
}

// Assign each embedding to its nearest cell and add it. An empty index bootstraps a first cell from the
// inserted batch; a cell that crosses splitAt*cellTarget splits in place. undefined while not synced.
export function insertEmbeddings(
    database: Database<IvfEmbeddingRoot>,
    items: EmbeddingInput[],
): true | undefined {
    if (!items.length) return true;
    const config = database.readData(root => root.config);
    if (!config) return undefined;
    const centroids = transactionRead<StoredEmbedding>(centroidStore(database));
    if (!centroids) return undefined;

    const newCentroids: { key: string; value: StoredEmbedding | undefined }[] = [];
    if (!centroids.size) {
        const centroid = averageEmbeddings(items.map(item => item.embedding), config);
        const cellId = hashEmbedding(centroid);
        centroids.set(cellId, centroid);
        newCentroids.push({ key: cellId, value: centroid });
    }

    const itemsByCell = new Map<string, EmbeddingInput[]>();
    for (const item of items) {
        const cellId = nearestCell(item.embedding, centroids);
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

    const splitThreshold = config.splitAt * config.cellTarget;
    const refWrites: { key: string; value: string | undefined }[] = [];
    for (let cellIndex = 0; cellIndex < targetCellIds.length; cellIndex++) {
        const cellId = targetCellIds[cellIndex];
        const group = itemsByCell.get(cellId)!;
        const combined = replayTransactionStore<StoredEmbedding>(existingStores[cellIndex]);
        for (const item of group) {
            combined.set(item.ref, item.embedding);
        }

        if (combined.size <= splitThreshold) {
            const memberWrites = group.map(item => ({ key: item.ref, value: item.embedding }));
            if (!transactionMutate(cellStore(database, cellId), memberWrites)) return undefined;
            for (const item of group) {
                refWrites.push({ key: item.ref, value: cellId });
            }
            continue;
        }

        const subCells = splitInTwo([...combined.entries()], config);
        for (const subCell of subCells) {
            const subCellId = hashEmbedding(subCell.centroid);
            newCentroids.push({ key: subCellId, value: subCell.centroid });
            const memberWrites = subCell.members.map(([ref, embedding]) => ({ key: ref, value: embedding }));
            if (!transactionMutate(cellStore(database, subCellId), memberWrites)) return undefined;
            for (const [ref] of subCell.members) {
                refWrites.push({ key: ref, value: subCellId });
            }
        }
        newCentroids.push({ key: cellId, value: undefined });
        database.deleteData(root => root.cells[cellId]);
    }

    if (newCentroids.length && !transactionMutate(centroidStore(database), newCentroids)) return undefined;
    if (refWrites.length && !transactionMutate(refIndexStore(database), refWrites)) return undefined;
    return true;
}

// Tombstone each ref in its cell (found via refIndex) and drop it from the index. undefined while not synced.
export function removeEmbeddings(
    database: Database<IvfEmbeddingRoot>,
    refs: string[],
): true | undefined {
    if (!refs.length) return true;
    const refIndex = transactionRead<string>(refIndexStore(database));
    if (!refIndex) return undefined;

    const refsByCell = new Map<string, string[]>();
    for (const ref of refs) {
        const cellId = refIndex.get(ref);
        if (!cellId) continue;
        let group = refsByCell.get(cellId);
        if (!group) {
            group = [];
            refsByCell.set(cellId, group);
        }
        group.push(ref);
    }

    for (const [cellId, group] of refsByCell) {
        const memberDeletes = group.map(ref => ({ key: ref, value: undefined }));
        if (!transactionMutate<StoredEmbedding>(cellStore(database, cellId), memberDeletes)) return undefined;
    }
    const refDeletes = refs.map(ref => ({ key: ref, value: undefined }));
    if (!transactionMutate<string>(refIndexStore(database), refDeletes)) return undefined;
    return true;
}
