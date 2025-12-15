import { isNode } from "typesafecss";
import { DelayedStorage } from "./DelayedStorage";
import { FileStorage, getFileStorage, getFileStorageNested } from "./FileFolderAPI";
import { IStorage, IStorageRaw, IStorageSync } from "./IStorage";
import { JSONStorage } from "./JSONStorage";
import { StorageSync } from "./StorageObservable";
import { TransactionStorage } from "./TransactionStorage";
import { PendingStorage } from "./PendingStorage";
import { isDefined } from "../misc/types";
import { PrivateFileSystemStorage } from "./PrivateFileSystemStorage";
import { isInChromeExtension } from "../misc/environment";
import { CBORStorage } from "./CBORStorage";

export class DiskCollection<T> implements IStorageSync<T> {
    constructor(
        private collectionName: string,
        private config?: {
            writeDelay?: number;
            cbor?: boolean;
            noPrompt?: boolean;
        }
    ) {
    }
    public transactionStorage: TransactionStorage | undefined;
    async initStorage(): Promise<IStorage<T>> {
        // If a Chrome extension, just return null. 
        if (isInChromeExtension()) return null as any;
        let curCollection: IStorageRaw;
        if (this.config?.noPrompt && !isNode()) {
            curCollection = await new PrivateFileSystemStorage(`collections/${this.collectionName}`);
        } else {
            let fileStorage = await getFileStorage();
            let collections = await fileStorage.folder.getStorage("collections");
            curCollection = await collections.folder.getStorage(this.collectionName);
        }
        let baseStorage = new TransactionStorage(curCollection, this.collectionName, this.config?.writeDelay);
        this.transactionStorage = baseStorage;
        return this.config?.cbor ? new CBORStorage<T>(baseStorage) : new JSONStorage<T>(baseStorage);
    }
    public baseStorage = this.initStorage();
    private synced = new StorageSync(
        new PendingStorage(`Collection (${this.collectionName})`,
            new DelayedStorage<T>(this.baseStorage)
        )
    );

    public get(key: string): T | undefined {
        return this.synced.get(key);
    }
    public async getPromise(key: string): Promise<T | undefined> {
        let base = await this.baseStorage;
        return base.get(key);
    }
    public set(key: string, value: T): void {
        this.synced.set(key, value);
    }
    public remove(key: string): void {
        this.synced.remove(key);
    }
    public getKeys(): string[] {
        return this.synced.getKeys();
    }
    public getKeysPromise(): Promise<string[]> {
        return this.synced.getKeysPromise();
    }

    public getEntries(): [string, T][] {
        let keys = this.getKeys();
        return keys.map(key => [key, this.get(key)]).filter(([_, value]) => isDefined(value)) as [string, T][];
    }
    public getValues(): T[] {
        let keys = this.getKeys();
        return keys.map(key => this.get(key)).filter(isDefined);
    }
    public async getValuesPromise(): Promise<T[]> {
        let keys = await this.getKeysPromise();
        let values: T[] = [];
        for (let key of keys) {
            let value = await this.getPromise(key);
            if (isDefined(value)) {
                values.push(value);
            }
        }
        return values;
    }
    public getInfo(key: string) {
        return this.synced.getInfo(key);
    }

    public async reset() {
        await this.synced.reset();
    }
}


export class DiskCollectionPromise<T> implements IStorage<T> {
    constructor(
        private collectionName: string,
        private writeDelay?: number,
    ) { }
    async initStorage(): Promise<IStorage<T>> {
        let fileStorage = await getFileStorage();
        let collections = await fileStorage.folder.getStorage("collections");
        let curCollection = await collections.folder.getStorage(this.collectionName);
        let baseStorage = new TransactionStorage(curCollection, this.collectionName, this.writeDelay);
        return new JSONStorage<T>(baseStorage);
    }
    private synced = (
        new PendingStorage(`Collection (${this.collectionName})`,
            new DelayedStorage<T>(this.initStorage())
        )
    );

    public async get(key: string): Promise<T | undefined> {
        return await this.synced.get(key);
    }
    public async set(key: string, value: T): Promise<void> {
        await this.synced.set(key, value);
    }
    public async remove(key: string): Promise<void> {
        await this.synced.remove(key);
    }
    public async getKeys(): Promise<string[]> {
        return await this.synced.getKeys();
    }
    public async getInfo(key: string) {
        return await this.synced.getInfo(key);
    }

    public async reset() {
        await this.synced.reset();
    }
}

export class DiskCollectionRaw implements IStorage<Buffer> {
    constructor(private collectionName: string) { }
    async initStorage(): Promise<IStorage<Buffer>> {
        let fileStorage = await getFileStorage();
        let collections = await fileStorage.folder.getStorage("collections");
        let baseStorage = await collections.folder.getStorage(this.collectionName);
        return baseStorage;
    }
    private synced = (
        new PendingStorage(`Collection (${this.collectionName})`,
            new DelayedStorage(this.initStorage())
        )
    );

    public async get(key: string): Promise<Buffer | undefined> {
        return await this.synced.get(key);
    }
    public async set(key: string, value: Buffer): Promise<void> {
        await this.synced.set(key, value);
    }
    public async remove(key: string): Promise<void> {
        await this.synced.remove(key);
    }
    public async getKeys(): Promise<string[]> {
        return await this.synced.getKeys();
    }
    public async getInfo(key: string) {
        return await this.synced.getInfo(key);
    }

    public async reset() {
        await this.synced.reset();
    }
}

export class DiskCollectionRawBrowser {
    constructor(private collectionName: string) { }
    async initStorage(): Promise<IStorage<Buffer>> {
        return await new PrivateFileSystemStorage(`collections/${this.collectionName}`);
    }
    private synced = new StorageSync(
        new PendingStorage(`Collection (${this.collectionName})`,
            new DelayedStorage(this.initStorage())
        )
    );

    public get(key: string): Buffer | undefined {
        return this.synced.get(key);
    }

    public async getPromise(key: string): Promise<Buffer | undefined> {
        return await this.synced.get(key);
    }
    public set(key: string, value: Buffer) {
        this.synced.set(key, value);
    }
    public async getKeys(): Promise<string[]> {
        return await this.synced.getKeys();
    }
    public async getInfo(key: string) {
        return await this.synced.getInfo(key);
    }

    public async reset() {
        await this.synced.reset();
    }
}

export function newFileStorageBufferSyncer(folder = "") {
    let base = new PendingStorage(`FileStorageBufferSyncer`,
        new DelayedStorage(getFileStorageNested(folder))
    );
    return new StorageSync(base);
}

export function newFileStorageJSONSyncer<T>(folder = "") {
    let base = new PendingStorage(`FileStorageJSONSyncer`,
        new DelayedStorage(getFileStorageNested(folder))
    );
    return new StorageSync(new JSONStorage<T>(base));
}