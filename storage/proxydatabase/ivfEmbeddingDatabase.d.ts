import { Database } from "./Database";
import { TransactionSetStore } from "./transactionSet";
import { StoredEmbedding, EmbeddingFormat } from "../embeddingFormats";
export type IvfConfig = {
    model: string;
    format: EmbeddingFormat;
    cellTarget: number;
    splitAt: number;
};
export type IvfEmbeddingRoot = {
    config: IvfConfig;
    centroids: TransactionSetStore;
    cells: {
        [cellId: string]: TransactionSetStore;
    };
    refIndex: TransactionSetStore;
};
export type EmbeddingInput = {
    ref: string;
    embedding: StoredEmbedding;
};
export type SearchHit = {
    ref: string;
    closeness: number;
};
export declare function searchEmbeddings(database: Database<IvfEmbeddingRoot>, query: StoredEmbedding, options: {
    probeBudget: number;
    resultCount: number;
}): SearchHit[] | undefined;
export declare function insertEmbeddings(database: Database<IvfEmbeddingRoot>, items: EmbeddingInput[]): true | undefined;
export declare function removeEmbeddings(database: Database<IvfEmbeddingRoot>, refs: string[]): true | undefined;
