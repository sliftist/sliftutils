import { DelayedStorage } from "./DelayedStorage";
import { getFileStorageNested } from "./FileFolderAPI";
import { IStorageSync } from "./IStorage";
import { JSONStorage } from "./JSONStorage";
import { PendingStorage } from "./PendingStorage";
import { StorageSync } from "./StorageObservable";

export function newCachedStrStorage<T>(
    folder: string,
    getValue: (key: string) => Promise<T>
) {
    let base = new PendingStorage(`CachedStrStorage`,
        new DelayedStorage(getFileStorageNested(folder))
    );
    let storage = new StorageSync(new JSONStorage<T>(base));
    let pending = new Set<string>();
    let baseStorageGet = storage.get;
    storage.get = (key: string) => {
        if (!pending.has(key)) {
            pending.add(key);

            (async () => {
                let existingValue = await storage.getPromise(key);
                if (existingValue) return;
                let value = await getValue(key);
                storage.set(key, value);
            })().catch(console.error);
        }
        return baseStorageGet.call(storage, key);
    };
    return storage;
}