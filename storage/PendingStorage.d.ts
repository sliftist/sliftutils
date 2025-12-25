import { IStorage } from "./IStorage";
export declare class PendingStorage<T> implements IStorage<T> {
    private pendingGroup;
    private storage;
    pending: Map<string, number>;
    constructor(pendingGroup: string, storage: IStorage<T>);
    get(key: string): Promise<T | undefined>;
    set(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
    getKeys(): Promise<string[]>;
    getInfo(key: string): Promise<{
        size: number;
        lastModified: number;
    } | undefined>;
    private watchPending;
    private updatePending;
    reset(): Promise<void>;
    watchResync(callback: () => void): void;
}
