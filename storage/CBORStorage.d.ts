/// <reference types="node" />
/// <reference types="node" />
import { IStorage } from "./IStorage";
export declare class CBORStorage<T> implements IStorage<T> {
    private storage;
    constructor(storage: IStorage<Buffer>);
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
