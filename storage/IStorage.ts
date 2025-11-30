// TODO: Create a IStorageKeyEscaped interface, which uses escaping so that any keys
//      are allowed. At the moment if you use keys which the underlying storage (ex,
//      the file system) doesn't support, it will just throw.

export type IStorageSync<T> = {
    get(key: string): T | undefined;
    set(key: string, value: T): void;
    remove(key: string): void;
    getKeys(): string[];
    getValues(): T[];
    getEntries(): [string, T][];
    getInfo(key: string): { size: number; lastModified: number } | undefined;
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
// NOTE: In the file system some characters are disallowed, and some characters do special things
//  (/ makes a folder). And there are even more rules, such as lengths per folder, etc, etc.
export type IStorageRaw = {
    get(key: string): Promise<Buffer | undefined>;
    // May or may not be efficient in the underlying storage
    append(key: string, value: Buffer): Promise<void>;
    set(key: string, value: Buffer): Promise<void>;
    remove(key: string): Promise<void>;
    getKeys(): Promise<string[]>;
    getInfo(key: string): Promise<undefined | {
        size: number;
        lastModified: number;
    }>;
    reset(): Promise<void>;
};
