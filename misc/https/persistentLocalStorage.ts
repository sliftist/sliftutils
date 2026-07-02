import { isNode } from "socket-function/src/misc";
import fs from "fs";
import os from "os";
import { MaybePromise } from "socket-function/src/types";
import { cache } from "socket-function/src/caching";

// Stores structured-cloneable values (including non-extractable CryptoKeys) in IndexedDB.
export function getIDBKeyStore<T>(appName: string, key: string): {
    get(): Promise<T | undefined>;
    set(value: T | undefined): Promise<void>;
} {
    async function withStore<R>(mode: IDBTransactionMode, fnc: (store: IDBObjectStore) => IDBRequest<R>): Promise<R> {
        let openReq = indexedDB.open(`keystore_${appName}`, 1);
        openReq.onupgradeneeded = () => openReq.result.createObjectStore("kv");
        let db = await new Promise<IDBDatabase>((resolve, reject) => {
            openReq.onsuccess = () => resolve(openReq.result);
            openReq.onerror = () => reject(openReq.error);
        });
        try {
            let req = fnc(db.transaction("kv", mode).objectStore("kv"));
            return await new Promise<R>((resolve, reject) => {
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } finally {
            db.close();
        }
    }
    return {
        async get() {
            return await withStore("readonly", store => store.get(key)) as T | undefined;
        },
        async set(value: T | undefined) {
            if (!value) {
                await withStore("readwrite", store => store.delete(key));
                return;
            }
            await withStore("readwrite", store => store.put(value, key));
        },
    };
}

export function getKeyStore<T>(appName: string, key: string): {
    get(): MaybePromise<T | undefined>;
    set(value: T | null): MaybePromise<void>;
} {
    if (isNode()) {
        let path = os.homedir() + `/keystore_${appName}_` + key + ".json";
        return {
            get() {
                let contents: string | undefined = undefined;
                try { contents = fs.readFileSync(path, "utf8"); } catch { }
                if (!contents) return undefined;
                return JSON.parse(contents) as T;
            },
            set(value: T | null) {
                fs.writeFileSync(path, JSON.stringify(value));
            }
        };
    } else {
        return {
            get() {
                let json = localStorage.getItem(key);
                if (!json) return undefined;
                return JSON.parse(json) as T;
            },
            set(value: T | null) {
                localStorage.setItem(key, JSON.stringify(value));
            }
        };
    }
}