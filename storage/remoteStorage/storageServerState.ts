import path from "path";
import { getFileStorageNested2 } from "../FileFolderAPI";
import { TransactionStorage } from "../TransactionStorage";
import { JSONStorage } from "../JSONStorage";
import { ArchivesDisk } from "../ArchivesDisk";
import { BlobStore, IBucketStore } from "./blobStore";
import type { IStorage } from "../IStorage";
import type { AccessRequest, TrustRecord, BucketConfig } from "./storageController";

// The storage server's global server-side state. hostStorageServer sets the config once at
// startup; everything else (system storages, blob stores) is a global cache created lazily on
// first use, throwing if the config was never set. This module is node-only — storageController
// (which is loaded in the browser) requires it lazily, inside its server-side function bodies.

export type StorageServerConfig = {
    domain: string;
    port: number;
    rootDomain: string;
    // user@externalIp of the storage machine, for generated ssh commands
    sshTarget: string;
    // Absolute command that runs the grantAccess CLI on the storage machine (admin args appended)
    serverCommand: string;
    // The server's root storage folder (absolute)
    folder: string;
};

let config: StorageServerConfig | undefined;
export function setStorageServerConfig(value: StorageServerConfig): void {
    config = value;
}
export function getStorageServerConfig(): StorageServerConfig {
    if (!config) {
        throw new Error(`Storage server is not initialized (this API only works on the storage server)`);
    }
    return config;
}

// When set, all write-path operations (creating files, appending large uploads, creating buckets)
// throw this message. Reads, findInfo, and deletes still work — so clients can free space. Managed
// by hostStorageServer's disk-space monitor.
let writesRejectedReason: string | undefined;
export function setWritesRejectedReason(reason: string | undefined): void {
    writesRejectedReason = reason;
}
export function getWritesRejectedReason(): string | undefined {
    return writesRejectedReason;
}

// The system storages (trust, requests, buckets) are all the same kind of thing — a JSON
// key/value store under <folder>/system/<name> — so they share one cache, keyed by name.
const systemStorages = new Map<string, Promise<IStorage<unknown>>>();
function getSystemStorage<T>(name: string): Promise<IStorage<T>> {
    let storage = systemStorages.get(name);
    if (!storage) {
        storage = (async () => {
            let root = await getFileStorageNested2(getStorageServerConfig().folder);
            let system = await root.folder.getStorage("system");
            let transactionName = "storage" + name[0].toUpperCase() + name.slice(1);
            return new JSONStorage<unknown>(new TransactionStorage(await system.folder.getStorage(name), transactionName));
        })();
        systemStorages.set(name, storage);
    }
    return storage as Promise<IStorage<T>>;
}
export function getTrust(): Promise<IStorage<TrustRecord>> {
    return getSystemStorage<TrustRecord>("trust");
}
export function getRequests(): Promise<IStorage<AccessRequest[]>> {
    return getSystemStorage<AccessRequest[]>("requests");
}
export function getBuckets(): Promise<IStorage<BucketConfig>> {
    return getSystemStorage<BucketConfig>("buckets");
}

// Each bucket has its own store (in its own folder, see BucketConfig.folder), cached per folder
// and created on first use.
const blobStores = new Map<string, IBucketStore>();
export function getBlobStore(bucket: BucketConfig): IBucketStore {
    let store = blobStores.get(bucket.folder);
    if (!store) {
        let bucketFolder = path.join(getStorageServerConfig().folder, bucket.folder);
        if (bucket.rawDisk) {
            store = new ArchivesDisk(bucketFolder);
        } else {
            // Synchronization sources are global (BlobStore doesn't namespace them), so the disk
            // source is rooted at the full absolute folder, including the bucket's name
            store = new BlobStore(bucketFolder, [{
                source: new ArchivesDisk(bucketFolder),
                options: { cacheReads: true, required: true, validWindow: [0, Number.MAX_SAFE_INTEGER] },
            }]);
        }
        blobStores.set(bucket.folder, store);
    }
    return store;
}
