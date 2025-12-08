/// <reference types="node" />
/// <reference types="node" />
export type IStorageSync<T> = {
    get(key: string): T | undefined;
    set(key: string, value: T): void;
    remove(key: string): void;
    getKeys(): string[];
    getValues(): T[];
    getEntries(): [string, T][];
    getInfo(key: string): {
        size: number;
        lastModified: number;
    } | undefined;
    reset(): Promise<void>;
};
export type IStorage<T> = {
    get(key: string): Promise<T | undefined>;
    set(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
    getKeys(): Promise<string[]>;
    getInfo(key: string): Promise<undefined | {
        size: number;
        lastModified: number;
    }>;
    reset(): Promise<void>;
};
export type IStorageRaw = {
    get(key: string): Promise<Buffer | undefined>;
    append(key: string, value: Buffer): Promise<void>;
    set(key: string, value: Buffer): Promise<void>;
    remove(key: string): Promise<void>;
    getKeys(includeFolders?: boolean): Promise<string[]>;
    getInfo(key: string): Promise<undefined | {
        size: number;
        lastModified: number;
    }>;
    reset(): Promise<void>;
};
