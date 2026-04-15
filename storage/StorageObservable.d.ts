import { IStorage, IStorageSync } from "./IStorage";
export declare const storagePendingAccesses: {
    value: number;
};
export declare class StorageSync<T> implements IStorageSync<T> {
    storage: IStorage<T>;
    private config?;
    cached: import("mobx").ObservableMap<string, T | undefined>;
    infoCached: import("mobx").ObservableMap<string, {
        size: number;
        lastModified: number;
    } | undefined>;
    keys: Set<string>;
    synced: {
        keySeqNum: number;
    };
    constructor(storage: IStorage<T>, config?: {
        freeze?: "deep" | "shallow" | undefined;
        beforeWrite?: ((update: {
            newValue: T;
            key: string;
            collection: StorageSync<T>;
        }) => void) | undefined;
    } | undefined);
    get(key: string): T | undefined;
    set(key: string, value: T): void;
    remove(key: string): void;
    private loadedKeys;
    getKeys(): string[];
    getInfo(key: string): {
        size: number;
        lastModified: number;
    } | undefined;
    getValues(): T[];
    getEntries(): [string, T][];
    getPromise(key: string): Promise<T | undefined>;
    private pendingGetKeys;
    getKeysPromise(): Promise<string[]>;
    reload(): void;
    reloadKeys(): void;
    reloadKey(key: string): void;
    reset(): Promise<void>;
}
export declare function waitUntilNextLoad(): Promise<void>;
