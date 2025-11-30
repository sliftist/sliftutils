import { lazy } from "socket-function/src/caching";
import { IStorageRaw } from "./IStorage";
import { FileStorage } from "./FileFolderAPI";

const DB_NAME = "FileStorage";
const STORE_NAME = "files";
const DB_VERSION = 1;

interface FileRecord {
    data: Buffer;
    lastModified: number;
}

class VirtualFileStorage implements FileStorage {
    private db: IDBDatabase;

    constructor(
        db: IDBDatabase,
        public readonly id: string
    ) {
        if (!db) debugger;
        this.db = db;
    }

    private getStore(mode: IDBTransactionMode = "readonly") {
        const transaction = this.db.transaction(STORE_NAME, mode);
        return transaction.objectStore(STORE_NAME);
    }

    private request<T>(request: IDBRequest<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }


    // IStorageRaw implementation
    async get(key: string): Promise<Buffer | undefined> {
        const store = this.getStore();
        const result = await this.request<FileRecord | undefined>(store.get(this.id + key));
        let badBuffer = result?.data;
        if (badBuffer) badBuffer = Buffer.from(badBuffer);
        return badBuffer;
    }

    async append(key: string, value: Buffer): Promise<void> {
        const store = this.getStore("readwrite");
        const fullPath = this.id + key;
        const existing = await this.request<FileRecord | undefined>(store.get(fullPath));

        const newRecord: FileRecord = {
            data: existing
                ? Buffer.concat([existing.data, value])
                : value,
            lastModified: Date.now()
        };

        await this.request(store.put(newRecord, fullPath));
    }

    async set(key: string, value: Buffer): Promise<void> {
        const store = this.getStore("readwrite");
        const record: FileRecord = {
            data: value,
            lastModified: Date.now()
        };
        await this.request(store.put(record, this.id + key));
    }

    async remove(key: string): Promise<void> {
        const store = this.getStore("readwrite");
        await this.request(store.delete(this.id + key));
    }

    private async getKeysWithPrefix(prefix: string): Promise<string[]> {
        const store = this.getStore();
        const range = IDBKeyRange.bound(prefix, prefix + "\uffff", false, true);

        return new Promise((resolve, reject) => {
            const keys: string[] = [];
            const request = store.openCursor(range);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    let newKey = cursor.key as string;
                    newKey = newKey.slice(this.id.length);
                    keys.push(newKey);
                    cursor.continue();
                } else {
                    resolve(keys);
                }
            };
        });
    }

    async getKeys(): Promise<string[]> {
        let keys = await this.getKeysWithPrefix(this.id);
        return keys.filter(x => !x.includes("/"));
    }

    async getInfo(key: string): Promise<{ size: number; lastModified: number; } | undefined> {
        const store = this.getStore();
        const result = await this.request<FileRecord | undefined>(store.get(this.id + key));

        if (!result) return undefined;

        return {
            size: result.data.length,
            lastModified: result.lastModified
        };
    }

    async reset(): Promise<void> {
        let keys = await this.getKeysWithPrefix(this.id);
        for (let key of keys) {
            await this.remove(key);
        }
    }

    // NestedFileStorage implementation
    folder = {
        hasKey: async (key: string): Promise<boolean> => {
            const folderPath = this.id + key + "/";
            const keys = await this.getKeysWithPrefix(folderPath);
            return keys.length > 0;
        },

        getStorage: async (key: string): Promise<FileStorage> => {
            const newPath = this.id + key + "/";
            return new VirtualFileStorage(this.db, newPath);
        },

        removeStorage: async (key: string): Promise<void> => {
            let nested = new VirtualFileStorage(this.db, this.id + key + "/");
            await nested.reset();
        },

        getKeys: async (): Promise<string[]> => {
            let keys = await this.getKeysWithPrefix(this.id);
            let folderKeys = new Set<string>();
            for (let key of keys) {
                if (!key.includes("/")) continue;
                let parts = key.split("/");
                folderKeys.add(parts[0]);
            }
            return Array.from(folderKeys);
        }
    };
}

export const getFileStorageIndexDB = lazy(async (): Promise<FileStorage> => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
    });

    return new VirtualFileStorage(db, "/");
});