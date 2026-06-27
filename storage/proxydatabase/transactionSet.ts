import cborx from "cbor-x";
import { Database } from "./Database";

// structuredClone preserves typed arrays, Maps, undefined, Dates, etc. Mirrors the
// encoder the BulkDatabase2 stream log uses.
const transactionCbor = new cborx.Encoder({ structuredClone: true });

// A log-structured, deletable string→value map laid over the proxy database.
//
// Storage shape (what a transaction-set database is namespaced to): an object keyed
// by a monotonic FILE number; each file is a CBOR array of transactions, so a single
// write of several entries shares one file. A transaction is one key set to one value
// (undefined = delete) tagged with a global monotonic SEQUENCE number. The current
// state is every transaction replayed in sequence order, last write wins.
//
// Reads pull the whole set at once (Object.keys/values are efficient on the backing
// store). Mutations append a new file and, once enough files accumulate, fold the
// whole set into one — deduping (an add then delete then add of a key keeps only its
// final value). Values are CBOR-encoded; keys are arbitrary strings.
export type TransactionSetStore = { [fileNumber: string]: Uint8Array };

type Transaction = { sequence: number; key: string; value: unknown };

const DEFAULT_COMPACT_AFTER_FILES = 16;

function maxNumber(values: number[], fallback: number): number {
    let result = fallback;
    for (const value of values) if (value > result) result = value;
    return result;
}

// One batched read of every file. undefined if the set isn't synced yet.
function readTransactionFiles(
    database: Database<TransactionSetStore>,
): { fileKeys: string[]; transactions: Transaction[] } | undefined {
    const snapshot = database.readData(store => ({
        fileKeys: Object.keys(store),
        buffers: Object.values(store),
    }));
    if (snapshot === undefined) return undefined;
    const transactions: Transaction[] = [];
    for (const buffer of snapshot.buffers) {
        for (const transaction of transactionCbor.decode(buffer) as Transaction[]) transactions.push(transaction);
    }
    return { fileKeys: snapshot.fileKeys, transactions };
}

function replay(transactions: Transaction[]): Map<string, unknown> {
    const ordered = transactions.slice().sort((left, right) => left.sequence - right.sequence);
    const state = new Map<string, unknown>();
    for (const transaction of ordered) {
        if (transaction.value === undefined) state.delete(transaction.key);
        else state.set(transaction.key, transaction.value);
    }
    return state;
}

// Internal: fold every transaction into one merged file, then delete the old ones.
// Not exported — only transactionMutate triggers it, with data it already read, so
// the merge sees the incoming transactions without re-reading. Deletes by the
// ORIGINAL string key, so a stray non-numeric key still gets removed.
function compactTransactions(
    database: Database<TransactionSetStore>,
    allTransactions: Transaction[],
    oldFileKeys: string[],
    newFileNumber: number,
): void {
    const finalState = replay(allTransactions);
    const merged: Transaction[] = [...finalState].map(([key, value], index) => ({ sequence: index, key, value }));
    database.writeData(store => store[String(newFileNumber)], transactionCbor.encode(merged) as Uint8Array);
    for (const fileKey of oldFileKeys) database.deleteData(store => store[fileKey]);
}

// All current values as key → deserialized value. undefined while not synced.
export function transactionRead<Value>(
    database: Database<TransactionSetStore>,
): Map<string, Value> | undefined {
    const files = readTransactionFiles(database);
    if (files === undefined) return undefined;
    return replay(files.transactions) as Map<string, Value>;
}

// Append these transactions (value undefined = delete) as one new file, each given
// the next sequence number — unless that would reach compactAfterFiles, in which
// case fold everything into a single file instead. undefined while not synced (the
// retry wrapper re-runs us later). Number() is only used to find the next file
// number; files are always stored + deleted under their raw string key.
export function transactionMutate<Value>(
    database: Database<TransactionSetStore>,
    transactions: { key: string; value: Value | undefined }[],
    compactAfterFiles: number = DEFAULT_COMPACT_AFTER_FILES,
): true | undefined {
    const files = readTransactionFiles(database);
    if (files === undefined) return undefined;
    if (transactions.length === 0) return true;

    const baseSequence = maxNumber(files.transactions.map(transaction => transaction.sequence), -1) + 1;
    const incoming: Transaction[] = transactions.map((transaction, index) => ({
        sequence: baseSequence + index,
        key: transaction.key,
        value: transaction.value,
    }));
    const nextFileNumber = maxNumber(files.fileKeys.map(fileKey => Number(fileKey)), -1) + 1;

    if (files.fileKeys.length + 1 >= compactAfterFiles) {
        compactTransactions(database, [...files.transactions, ...incoming], files.fileKeys, nextFileNumber);
    } else {
        database.writeData(store => store[String(nextFileNumber)], transactionCbor.encode(incoming) as Uint8Array);
    }
    return true;
}
