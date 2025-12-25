import { lazy } from "socket-function/src/caching";
import { IStorage } from "./IStorage";
import cborx from "cbor-x";
const cborEncoder = lazy(() => new cborx.Encoder({ structuredClone: true }));


export class CBORStorage<T> implements IStorage<T> {
    constructor(private storage: IStorage<Buffer>) { }
    public async get(key: string): Promise<T | undefined> {
        let buffer = await this.storage.get(key);
        if (buffer === undefined) {
            return undefined;
        }
        try {
            return cborEncoder().decode(buffer);
        } catch (e) {
            console.warn(`Failed to parse CBOR for key: ${key}`, e);
        }
    }
    public async set(key: string, value: T): Promise<void> {
        await this.storage.set(key, cborEncoder().encode(value));
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

