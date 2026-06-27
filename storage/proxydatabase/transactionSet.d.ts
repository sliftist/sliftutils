import { Database } from "./Database";
export type TransactionSetStore = {
    [fileNumber: string]: Uint8Array;
};
export declare function transactionRead<Value>(database: Database<TransactionSetStore>): Map<string, Value> | undefined;
export declare function replayTransactionStore<Value>(store: TransactionSetStore | undefined): Map<string, Value>;
export declare function transactionMutate<Value>(database: Database<TransactionSetStore>, transactions: {
    key: string;
    value: Value | undefined;
}[], compactAfterFiles?: number): true | undefined;
