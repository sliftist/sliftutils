import { IStorage } from "./IStorage";

export class DelayedStorage<T> implements IStorage<T> {
    constructor(private storage: Promise<IStorage<T>>) { }
    public async get(key: string): Promise<T | undefined> {
        const storage = await this.storage;
        return storage.get(key);
    }
    public async set(key: string, value: T): Promise<void> {
        const storage = await this.storage;
        return storage.set(key, value);
    }
    public async remove(key: string): Promise<void> {
        const storage = await this.storage;
        return storage.remove(key);
    }
    public async getKeys(): Promise<string[]> {
        const storage = await this.storage;
        return storage.getKeys();
    }
    public async getInfo(key: string) {
        const storage = await this.storage;
        return storage.getInfo(key);
    }

    public async reset() {
        const storage = await this.storage;
        return storage.reset();
    }
}