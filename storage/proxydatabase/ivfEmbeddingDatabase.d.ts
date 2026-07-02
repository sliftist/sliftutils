import { Database } from "./Database";
import { TransactionSetStore } from "./transactionSet";
import { StoredEmbedding, EmbeddingFormat } from "../embeddingFormats";
export type IvfConfig = {
    model: string;
    format: EmbeddingFormat;
    cellTargetSize: number;
};
export type IvfEmbeddingRoot = {
    config: IvfConfig;
    count: number;
    flat: TransactionSetStore<StoredEmbedding>;
    byRef: {
        [ref: string]: Uint8Array;
    };
    steps: {
        [step: string]: boolean;
    };
    centroids: TransactionSetStore<StoredEmbedding>;
    cells: {
        [cellId: string]: TransactionSetStore<StoredEmbedding>;
    };
};
export type EmbeddingInput = {
    ref: string;
    embedding: StoredEmbedding;
};
export type SearchHit = {
    ref: string;
    closeness: number;
};
export declare function rebuildStructure(database: Database<IvfEmbeddingRoot>): void;
export declare function searchEmbeddings(database: Database<IvfEmbeddingRoot>, query: StoredEmbedding, options: {
    probeBudget: number;
    resultCount: number;
}): SearchHit[] | undefined;
export declare function lookupEmbeddings(database: Database<IvfEmbeddingRoot>, refs: string[]): Map<string, StoredEmbedding> | undefined;
export declare function insertEmbeddings(database: Database<IvfEmbeddingRoot>, items: EmbeddingInput[]): undefined;
export declare function removeEmbeddings(database: Database<IvfEmbeddingRoot>, refs: string[]): void;
