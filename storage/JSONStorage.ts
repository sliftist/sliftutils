import { IStorage } from "./IStorage";

export class JSONStorage<T> implements IStorage<T> {
    constructor(private storage: IStorage<Buffer>) { }
    public async get(key: string): Promise<T | undefined> {
        let buffer = await this.storage.get(key);
        if (buffer === undefined) {
            return undefined;
        }
        try {
            return JSON.parse(buffer.toString());
        } catch (e) {
            console.warn(`Failed to parse JSON for key: ${key}`, buffer.toString(), e);
        }
    }
    public async set(key: string, value: T): Promise<void> {
        await this.storage.set(key, Buffer.from(JSON.stringify(value)));
    }
    public async remove(key: string): Promise<void> {
        await this.storage.remove(key);
    }
    public async getKeys(): Promise<string[]> {
        return await this.storage.getKeys();
    }
    public async getInfo(key: string) {
        return await this.storage.getInfo(key);
    }


    public watchResync(callback: () => void): void {
        this.storage.watchResync?.(callback);
    }

    public async reset() {
        await this.storage.reset();
    }
}