import cborx from "cbor-x";
import { Database } from "./Database";

// structuredClone keeps typed arrays / Maps / undefined intact through the round-trip.
const transactionCbor = new cborx.Encoder({ structuredClone: true });

// On the store: files keyed by a monotonic number, each a CBOR array of transactions; a transaction sets one key (value undefined = delete) and carries a global sequence number. Replaying every transaction in sequence order (last write wins) gives the current map. Mutations append a file, then fold the whole set into one once enough accumulate.
export type TransactionSetStore = { [fileNumber: string]: Uint8Array };

type Transaction = { sequence: number; key: string; value: unknown };

const DEFAULT_COMPACT_AFTER_FILES = 16;

function maxNumber(values: number[], fallback: number): number {
    let result = fallback;
    for (const value of values) {
        if (value > result) {
            result = value;
        }
    }
    return result;
}

function decodeBuffers(buffers: Uint8Array[]): Transaction[] {
    const transactions: Transaction[] = [];
    for (const buffer of buffers) {
        const decoded = transactionCbor.decode(buffer) as Transaction[];
        for (const transaction of decoded) {
            transactions.push(transaction);
        }
    }
    return transactions;
}

function readTransactionFiles(
    database: Database<TransactionSetStore>,
): { fileKeys: string[]; transactions: Transaction[] } | undefined {
    const snapshot = database.readData(store => ({
        fileKeys: Object.keys(store),
        buffers: Object.values(store),
    }));
    if (!snapshot) return undefined;
    return { fileKeys: snapshot.fileKeys, transactions: decodeBuffers(snapshot.buffers) };
}

function replay(transactions: Transaction[]): Map<string, unknown> {
    const ordered = transactions.slice().sort((left, right) => left.sequence - right.sequence);
    const state = new Map<string, unknown>();
    for (const transaction of ordered) {
        // undefined (not falsy) is the delete marker, so 0 / "" / false stay real values.
        if (transaction.value === undefined) {
            state.delete(transaction.key);
        } else {
            state.set(transaction.key, transaction.value);
        }
    }
    return state;
}

// Deletes old files by their ORIGINAL string key, so a stray non-numeric key still gets removed.
function compactTransactions(
    database: Database<TransactionSetStore>,
    allTransactions: Transaction[],
    oldFileKeys: string[],
    newFileNumber: number,
): void {
    const finalState = replay(allTransactions);
    const merged: Transaction[] = [...finalState].map(([key, value], index) => ({ sequence: index, key, value }));
    const encoded = transactionCbor.encode(merged) as Uint8Array;
    database.writeData(store => store[String(newFileNumber)], encoded);
    for (const fileKey of oldFileKeys) {
        database.deleteData(store => store[fileKey]);
    }
}

export function transactionRead<Value>(
    database: Database<TransactionSetStore>,
): Map<string, Value> | undefined {
    const files = readTransactionFiles(database);
    if (!files) return undefined;
    return replay(files.transactions) as Map<string, Value>;
}

// Replay an already-read store object (no read of its own), so a caller can fetch many sets in one batched read and then materialize each.
export function replayTransactionStore<Value>(store: TransactionSetStore | undefined): Map<string, Value> {
    if (!store) return new Map();
    return replay(decodeBuffers(Object.values(store))) as Map<string, Value>;
}

export function transactionMutate<Value>(
    database: Database<TransactionSetStore>,
    transactions: { key: string; value: Value | undefined }[],
    compactAfterFiles: number = DEFAULT_COMPACT_AFTER_FILES,
): true | undefined {
    const files = readTransactionFiles(database);
    if (!files) return undefined;
    if (!transactions.length) return true;

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
        const encoded = transactionCbor.encode(incoming) as Uint8Array;
        database.writeData(store => store[String(nextFileNumber)], encoded);
    }
    return true;
}
