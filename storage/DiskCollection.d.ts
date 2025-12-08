/// <reference types="node" />
/// <reference types="node" />
import { IStorage, IStorageSync } from "./IStorage";
import { StorageSync } from "./StorageObservable";
import { TransactionStorage } from "./TransactionStorage";
export declare class DiskCollection<T> implements IStorageSync<T> {
    private collectionName;
    private writeDelay?;
    constructor(collectionName: string, writeDelay?: number | undefined);
    transactionStorage: TransactionStorage | undefined;
    initStorage(): Promise<IStorage<T>>;
    baseStorage: Promise<IStorage<T>>;
    private synced;
    get(key: string): T | undefined;
    getPromise(key: string): Promise<T | undefined>;
    set(key: string, value: T): void;
    remove(key: string): void;
    getKeys(): string[];
    getKeysPromise(): Promise<string[]>;
    getEntries(): [string, T][];
    getValues(): T[];
    getValuesPromise(): Promise<T[]>;
    getInfo(key: string): {
        size: number;
        lastModified: number;
    } | undefined;
    reset(): Promise<void>;
}
export declare class DiskCollectionBrowser<T> implements IStorageSync<T> {
    private collectionName;
    private writeDelay?;
    constructor(collectionName: string, writeDelay?: number | undefined);
    transactionStorage: TransactionStorage | undefined;
    initStorage(): Promise<IStorage<T>>;
    baseStorage: Promise<IStorage<T>>;
    private synced;
    get(key: string): T | undefined;
    getPromise(key: string): Promise<T | undefined>;
    set(key: string, value: T): void;
    remove(key: string): void;
    getKeys(): string[];
    getKeysPromise(): Promise<string[]>;
    getEntries(): [string, T][];
    getValues(): T[];
    getValuesPromise(): Promise<T[]>;
    getInfo(key: string): {
        size: number;
        lastModified: number;
    } | undefined;
    reset(): Promise<void>;
}
export declare class DiskCollectionPromise<T> implements IStorage<T> {
    private collectionName;
    private writeDelay?;
    constructor(collectionName: string, writeDelay?: number | undefined);
    initStorage(): Promise<IStorage<T>>;
    private synced;
    get(key: string): Promise<T | undefined>;
    set(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
    getKeys(): Promise<string[]>;
    getInfo(key: string): Promise<{
        size: number;
        lastModified: number;
    } | undefined>;
    reset(): Promise<void>;
}
export declare class DiskCollectionRaw implements IStorage<Buffer> {
    private collectionName;
    constructor(collectionName: string);
    initStorage(): Promise<IStorage<Buffer>>;
    private synced;
    get(key: string): Promise<Buffer | undefined>;
    set(key: string, value: Buffer): Promise<void>;
    remove(key: string): Promise<void>;
    getKeys(): Promise<string[]>;
    getInfo(key: string): Promise<{
        size: number;
        lastModified: number;
    } | undefined>;
    reset(): Promise<void>;
}
export declare class DiskCollectionRawBrowser {
    private collectionName;
    constructor(collectionName: string);
    initStorage(): Promise<IStorage<Buffer>>;
    private synced;
    get(key: string): Buffer | undefined;
    getPromise(key: string): Promise<Buffer | undefined>;
    set(key: string, value: Buffer): void;
    getKeys(): Promise<string[]>;
    getInfo(key: string): Promise<{
        size: number;
        lastModified: number;
    } | undefined>;
    reset(): Promise<void>;
}
export declare function newFileStorageBufferSyncer(folder?: string): StorageSync<Buffer>;
export declare function newFileStorageJSONSyncer<T>(folder?: string): StorageSync<T>;
