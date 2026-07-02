import { Database } from "./Database";
declare const valueTag: unique symbol;
export type TransactionSetStore<Value> = {
    [fileNumber: string]: Uint8Array;
    [valueTag]?: Value;
};
export declare function transactionRead<Value>(database: Database<TransactionSetStore<Value>>): Map<string, Value> | undefined;
export declare function replayTransactionStore<Value>(store: TransactionSetStore<Value> | undefined): Map<string, Value>;
export declare function transactionMutate<Value>(database: Database<TransactionSetStore<Value>>, transactions: {
    key: string;
    value: Value | undefined;
}[], compactAfterFiles?: number): void;
export declare function transactionDelete<Value>(database: Database<TransactionSetStore<Value>>): void;
export {};
