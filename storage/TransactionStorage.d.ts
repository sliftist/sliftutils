/// <reference types="node" />
/// <reference types="node" />
import { IStorage, IStorageRaw } from "./IStorage";
interface TransactionEntry {
    key: string;
    value: Buffer | undefined;
    isZipped: boolean;
    time: number;
}
export declare class TransactionStorage implements IStorage<Buffer> {
    private rawStorage;
    private debugName;
    private writeDelay;
    cache: Map<string, TransactionEntry>;
    private currentChunk;
    private entryCount;
    private static allStorage;
    constructor(rawStorage: IStorageRaw, debugName: string, writeDelay?: number);
    static compressAll(): Promise<void>;
    private init;
    private getCurrentChunk;
    private onAddToChunk;
    get(key: string): Promise<Buffer | undefined>;
    set(key: string, value: Buffer): Promise<void>;
    remove(key: string): Promise<void>;
    getInfo(key: string): Promise<{
        size: number;
        lastModified: number;
    } | undefined>;
    private pendingAppends;
    private extraAppends;
    private pendingWrite;
    pushAppend(entry: TransactionEntry): Promise<void>;
    private updatePendingAppends;
    getKeys(): Promise<string[]>;
    private loadAllTransactions;
    private loadTransactionFile;
    private readTransactionEntry;
    private serializeTransactionEntry;
    private getHeader;
    private chunkBuffers;
    private compressing;
    private compressTransactionLog;
    reset(): Promise<void>;
}
export {};
