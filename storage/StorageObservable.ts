import { observable } from "mobx";
import { isDefined } from "../misc/types";
import { IStorage, IStorageSync } from "./IStorage";

// NOTE: At around 500K values (depending on their size to some degree), this will take about 2 minutes to load. But once it does it will be fast. So... keep that in mind. I recommend not exceeding 100K
export class StorageSync<T> implements IStorageSync<T> {
    cached = observable.map<string, T | undefined>(undefined, { deep: false });
    infoCached = observable.map<string, { size: number; lastModified: number } | undefined>(undefined, { deep: false });
    keys = new Set<string>();
    synced = observable({
        keySeqNum: 0,
    }, undefined, { deep: false });

    constructor(public storage: IStorage<T>) { }

    public get(key: string): T | undefined {
        if (!this.cached.has(key)) {
            this.cached.set(key, undefined);
            void this.getPromise(key);
        }
        if (this.cached.get(key) === undefined) {
            this.synced.keySeqNum;
        }
        return this.cached.get(key);
    }
    public set(key: string, value: T): void {
        if (!this.keys.has(key)) {
            this.keys.add(key);
            this.synced.keySeqNum++;
        }
        this.cached.set(key, value);
        void this.storage.set(key, value);
    }
    public remove(key: string): void {
        if (this.keys.has(key)) {
            this.keys.delete(key);
            this.synced.keySeqNum++;
        }
        this.cached.delete(key);
        void this.storage.remove(key);
    }
    private loadedKeys = false;
    public getKeys(): string[] {
        void this.getKeysPromise();
        this.synced.keySeqNum;
        return Array.from(this.keys);
    }

    public getInfo(key: string): { size: number; lastModified: number } | undefined {
        if (!this.infoCached.has(key)) {
            this.infoCached.set(key, { size: 0, lastModified: 0 });
            void this.storage.getInfo(key).then(info => {
                this.infoCached.set(key, info);
            });
        }
        return this.infoCached.get(key);
    }

    public getValues(): T[] {
        let keys = this.getKeys();
        return keys.map(key => this.get(key)).filter(isDefined);
    }
    public getEntries(): [string, T][] {
        let keys = this.getKeys();
        return keys.map(key => [key, this.get(key)]).filter(([_, value]) => isDefined(value)) as [string, T][];
    }


    public async getPromise(key: string): Promise<T | undefined> {
        let value = this.cached.get(key);
        if (value === undefined) {
            value = await this.storage.get(key);
            if (this.cached.get(key) === undefined) {
                this.cached.set(key, value);
            }
        }
        return value;
    }
    private pendingGetKeys: Promise<string[]> | undefined;
    public async getKeysPromise(): Promise<string[]> {
        if (this.pendingGetKeys) {
            return this.pendingGetKeys;
        }
        if (this.loadedKeys) return Array.from(this.keys);
        this.loadedKeys = true;
        this.pendingGetKeys = this.storage.getKeys();
        void this.pendingGetKeys.finally(() => {
            this.pendingGetKeys = undefined;
        });
        let keys = await this.pendingGetKeys;
        if (keys.length > 0) {
            this.keys = new Set(keys);
            this.synced.keySeqNum++;
        }
        return Array.from(this.keys);
    }

    public reload() {
        this.loadedKeys = false;
        this.synced.keySeqNum++;
        this.cached.clear();
        this.infoCached.clear();
        this.keys.clear();
    }
    public reloadKeys() {
        this.loadedKeys = false;
        this.synced.keySeqNum++;
    }
    public reloadKey(key: string) {
        this.cached.delete(key);
        this.infoCached.delete(key);
        this.keys.delete(key);
    }

    public async reset() {
        this.cached.clear();
        this.infoCached.clear();
        this.keys.clear();
        this.synced.keySeqNum++;
        await this.storage.reset();
    }
}