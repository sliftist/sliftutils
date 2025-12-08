import { IStorage } from "./IStorage";
export declare class DelayedStorage<T> implements IStorage<T> {
    private storage;
    constructor(storage: Promise<IStorage<T>>);
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
