import path from "path";
import { getFileStorageNested2 } from "../FileFolderAPI";
import { TransactionStorage } from "../TransactionStorage";
import { JSONStorage } from "../JSONStorage";
import { ArchivesDisk } from "../ArchivesDisk";
import { BlobStore, IBucketStore } from "./blobStore";
import {
    RemoteConfig, HostedConfig, IArchives, ArchivesSource, ArchiveFileInfo, ArchivesConfig,
    ArchivesSyncStatus, DEFAULT_BASE_SYNC_OPTIONS, DEFAULT_SYNC_OPTIONS,
} from "../IArchives";
import { ROUTING_FILE, parseRoutingData, parseHostedUrl, buildFileUrl } from "./remoteConfig";
import { createApiArchives } from "./createArchives";
import type { IStorage } from "../IStorage";
import type { AccessRequest, TrustRecord } from "./storageController";

// The storage server's global server-side state. hostStorageServer sets the config once at
// startup; everything else (system storages, buckets) is a global cache created lazily on first
// use, throwing if the config was never set.
//
// Buckets have no separate registry: each bucket's configuration (a RemoteConfig) lives inside the
// bucket itself, at ROUTING_FILE. A bucket exists iff that file exists. Writing it creates the
// bucket (building its store, which may immediately start synchronization scans); overwriting it —
// directly or via a file pulled in from a synchronization source — rebuilds the store with the new
// sources (cancelling the old store's scans).

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
// For self-detection: code that CAN run outside the storage server (createArchives) uses this to
// check "is this URL our own process?" without throwing.
export function getStorageServerConfigOptional(): StorageServerConfig | undefined {
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
export function assertWritesAllowed(): void {
    if (writesRejectedReason) throw new Error(writesRejectedReason);
}

// The system storages (trust, requests) are the same kind of thing — a JSON key/value store under
// <folder>/system2/<name> — so they share one cache, keyed by name. ("system2" because the layout
// changed when bucket configs moved into the buckets themselves; old "system"/"buckets" folders
// are simply ignored.)
const systemStorages = new Map<string, Promise<IStorage<unknown>>>();
function getSystemStorage<T>(name: string): Promise<IStorage<T>> {
    let storage = systemStorages.get(name);
    if (!storage) {
        storage = (async () => {
            let root = await getFileStorageNested2(getStorageServerConfig().folder);
            let system = await root.folder.getStorage("system2");
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

// ── buckets ──

export type LoadedBucket = {
    account: string;
    bucketName: string;
    // The bucket's parsed routing config (the contents of ROUTING_FILE)
    routing: RemoteConfig;
    // JSON of routing, for change detection
    routingJSON: string;
    // Our own entry in routing.sources (this bucket on this server), holding the bucket options
    // (public/fast/rawDisk/immutable/...). undefined when the config doesn't mention us.
    self: HostedConfig | undefined;
    store: IBucketStore;
};

const buckets = new Map<string, Promise<LoadedBucket | undefined>>();

function getBucketFolder(account: string, bucketName: string): string {
    return path.join(getStorageServerConfig().folder, "buckets2", account, bucketName);
}

function findSelfEntry(routing: RemoteConfig, account: string, bucketName: string): HostedConfig | undefined {
    let { domain, port } = getStorageServerConfig();
    for (let source of routing.sources) {
        if (typeof source === "string" || source.type !== "remote") continue;
        let parsed = parseHostedUrl(source.url);
        if (parsed.address === domain && parsed.port === port && parsed.account === account && parsed.bucketName === bucketName) {
            return source;
        }
    }
    return undefined;
}

function buildBucket(account: string, bucketName: string, routing: RemoteConfig): LoadedBucket {
    let folder = getBucketFolder(account, bucketName);
    let self = findSelfEntry(routing, account, bucketName);
    let store: IBucketStore;
    if (self?.rawDisk) {
        store = new ArchivesDisk(folder);
    } else {
        // Our own disk is the base source; the other routing entries are synchronization sources
        let sources: ArchivesSource[] = [{
            source: new ArchivesDisk(folder),
            options: self?.syncOptions || DEFAULT_BASE_SYNC_OPTIONS,
        }];
        for (let source of routing.sources) {
            if (typeof source === "string" || source === self) continue;
            sources.push({ source: createApiArchives(source), options: source.syncOptions || DEFAULT_SYNC_OPTIONS });
        }
        store = new BlobStore(folder, sources, {
            onIndexChanged: key => {
                // Fires for our own routing writes AND routing files pulled in via synchronization
                // (only ever newer ones, see IArchives.set) — either way, apply the new config
                if (key !== ROUTING_FILE) return;
                void scheduleRoutingReload(account, bucketName);
            },
        });
    }
    return { account, bucketName, routing, routingJSON: JSON.stringify(routing), self, store };
}

async function loadBucket(account: string, bucketName: string): Promise<LoadedBucket | undefined> {
    let data = await new ArchivesDisk(getBucketFolder(account, bucketName)).get(ROUTING_FILE);
    if (!data) return undefined;
    return buildBucket(account, bucketName, parseRoutingData(data));
}

export function getLoadedBucket(account: string, bucketName: string): Promise<LoadedBucket | undefined> {
    let key = `${account}/${bucketName}`;
    let loaded = buckets.get(key);
    if (!loaded) {
        loaded = loadBucket(account, bucketName);
        buckets.set(key, loaded);
        // Missing buckets are not cached — they can be created at any time (guarding against a
        // concurrent create having already replaced our entry)
        void loaded.then(bucket => {
            if (!bucket && buckets.get(key) === loaded) {
                buckets.delete(key);
            }
        }, () => {
            if (buckets.get(key) === loaded) {
                buckets.delete(key);
            }
        });
    }
    return loaded;
}

// Routing reloads are serialized per bucket, so concurrent writes/syncs can't rebuild the same
// store twice in parallel
const routingReloads = new Map<string, Promise<void>>();
function scheduleRoutingReload(account: string, bucketName: string): Promise<void> {
    let key = `${account}/${bucketName}`;
    let next = (routingReloads.get(key) || Promise.resolve())
        .then(() => checkRoutingChanged(account, bucketName))
        .catch(e => console.error(`Reloading routing config for bucket ${key} failed:`, e));
    routingReloads.set(key, next);
    return next;
}

async function checkRoutingChanged(account: string, bucketName: string): Promise<void> {
    let key = `${account}/${bucketName}`;
    let loaded = await buckets.get(key);
    if (!loaded) return;
    // get() cache-reads the file onto our disk when a remote source holds it, so the bucket still
    // exists after a restart
    let data = await loaded.store.get(ROUTING_FILE);
    if (!data) return;
    let routing = parseRoutingData(data);
    if (JSON.stringify(routing) === loaded.routingJSON) return;
    console.log(`Routing config changed for bucket ${key}, rebuilding its store`);
    if (loaded.store instanceof BlobStore) {
        await loaded.store.dispose();
    }
    buckets.set(key, Promise.resolve(buildBucket(account, bucketName, routing)));
}

function getWriteConfig(bucket: LoadedBucket): { fast?: boolean; writeDelay?: number } {
    return { fast: bucket.self?.fast, writeDelay: bucket.self?.writeDelay };
}

export async function assertMutable(bucket: LoadedBucket, filePath: string): Promise<void> {
    if (!bucket.self?.immutable) return;
    if (await bucket.store.getInfo(filePath)) {
        throw new Error(`Bucket ${bucket.account}/${bucket.bucketName} is immutable and ${JSON.stringify(filePath)} already exists, so it cannot be written to`);
    }
}

export async function writeBucketFile(account: string, bucketName: string, filePath: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
    assertWritesAllowed();
    let loaded = await getLoadedBucket(account, bucketName);
    if (filePath === ROUTING_FILE) {
        // Validates before storing anything, so a bad config can't brick the bucket
        parseRoutingData(data);
        if (!loaded) {
            let key = `${account}/${bucketName}`;
            await new ArchivesDisk(getBucketFolder(account, bucketName)).set(ROUTING_FILE, data, { lastModified: config?.lastModified });
            buckets.set(key, Promise.resolve(buildBucket(account, bucketName, parseRoutingData(data))));
            console.log(`Created bucket ${key}`);
            return;
        }
        // Routing writes bypass fast mode (the config must apply immediately and survive a crash)
        // and ignore immutable (the routing file must always stay updatable). An older lastModified
        // no-ops inside set, in which case the reload below sees no change.
        await loaded.store.set(ROUTING_FILE, data, { lastModified: config?.lastModified });
        await scheduleRoutingReload(account, bucketName);
        return;
    }
    if (!loaded) {
        throw new Error(`Bucket ${account}/${bucketName} does not exist. Write its routing config to ${JSON.stringify(ROUTING_FILE)} to create it.`);
    }
    await assertMutable(loaded, filePath);
    await loaded.store.set(filePath, data, { ...getWriteConfig(loaded), lastModified: config?.lastModified });
}

export async function deleteBucketFile(account: string, bucketName: string, filePath: string): Promise<void> {
    if (filePath === ROUTING_FILE) {
        throw new Error(`The routing config ${JSON.stringify(ROUTING_FILE)} cannot be deleted (overwrite it to change the bucket's configuration)`);
    }
    let loaded = await getLoadedBucket(account, bucketName);
    if (!loaded) return;
    await loaded.store.del(filePath, getWriteConfig(loaded));
}

// ── local IArchives access ──

const LARGE_FILE_PART_SIZE = 8 * 1024 * 1024;

// The in-process IArchives for a bucket hosted by THIS server — used when a RemoteConfig source
// URL points at ourselves, so we don't talk to ourselves over HTTPS. One singleton per bucket.
class ArchivesLocalBucket implements IArchives {
    constructor(private account: string, private bucketName: string) { }

    private async getBucket(): Promise<LoadedBucket | undefined> {
        return await getLoadedBucket(this.account, this.bucketName);
    }

    public getDebugName() {
        return `localBucket/${this.account}/${this.bucketName}`;
    }
    public async get(fileName: string, config?: { range?: { start: number; end: number } }): Promise<Buffer | undefined> {
        let result = await this.get2(fileName, config);
        return result && result.data || undefined;
    }
    public async get2(fileName: string, config?: { range?: { start: number; end: number } }): Promise<{ data: Buffer; writeTime: number } | undefined> {
        let bucket = await this.getBucket();
        if (!bucket) return undefined;
        return await bucket.store.get2(fileName, config);
    }
    public async set(fileName: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
        await writeBucketFile(this.account, this.bucketName, fileName, data, config);
    }
    public async del(fileName: string): Promise<void> {
        await deleteBucketFile(this.account, this.bucketName, fileName);
    }
    public async setLargeFile(config: { path: string; getNextData(): Promise<Buffer | undefined> }): Promise<void> {
        assertWritesAllowed();
        let bucket = await this.getBucket();
        if (!bucket) {
            throw new Error(`Bucket ${this.account}/${this.bucketName} does not exist. Write its routing config to ${JSON.stringify(ROUTING_FILE)} to create it.`);
        }
        await assertMutable(bucket, config.path);
        let id = await bucket.store.startLargeUpload();
        try {
            while (true) {
                let data = await config.getNextData();
                if (!data) break;
                for (let offset = 0; offset < data.length; offset += LARGE_FILE_PART_SIZE) {
                    await bucket.store.appendLargeUpload(id, data.subarray(offset, offset + LARGE_FILE_PART_SIZE));
                }
            }
            await bucket.store.finishLargeUpload(id, config.path);
        } catch (e) {
            await bucket.store.cancelLargeUpload(id);
            throw e;
        }
    }
    public async getInfo(fileName: string): Promise<{ writeTime: number; size: number } | undefined> {
        let bucket = await this.getBucket();
        if (!bucket) return undefined;
        return await bucket.store.getInfo(fileName);
    }
    public async findInfo(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        let bucket = await this.getBucket();
        if (!bucket) return [];
        return await bucket.store.findInfo(prefix, config);
    }
    public async find(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<string[]> {
        return (await this.findInfo(prefix, config)).map(x => x.path);
    }
    public async getURL(filePath: string): Promise<string> {
        let { domain, port } = getStorageServerConfig();
        return buildFileUrl(`https://${domain}:${port}/file/${encodeURIComponent(this.account)}/${encodeURIComponent(this.bucketName)}`, filePath);
    }
    public async getConfig(): Promise<ArchivesConfig> {
        let bucket = await this.getBucket();
        // Missing buckets say true, matching what they become once created (the default store type)
        return { supportsChangesAfter: !bucket || !!bucket.store.getChangesAfter };
    }
    public async getChangesAfter(time: number): Promise<ArchiveFileInfo[]> {
        let bucket = await this.getBucket();
        if (!bucket) return [];
        if (!bucket.store.getChangesAfter) {
            throw new Error(`Bucket ${this.account}/${this.bucketName} does not support getChangesAfter (rawDisk buckets have no index)`);
        }
        return await bucket.store.getChangesAfter(time);
    }
    public async getSyncStatus(): Promise<ArchivesSyncStatus> {
        let bucket = await this.getBucket();
        if (!bucket) return { allScansComplete: true, indexSize: 0, sources: [] };
        if (!bucket.store.getSyncStatus) {
            throw new Error(`Bucket ${this.account}/${this.bucketName} does not support getSyncStatus (rawDisk buckets have no synchronization)`);
        }
        return await bucket.store.getSyncStatus();
    }
}

const localArchives = new Map<string, IArchives>();
export function getLocalArchives(account: string, bucketName: string): IArchives {
    let key = `${account}/${bucketName}`;
    let existing = localArchives.get(key);
    if (existing) return existing;
    let archives = new ArchivesLocalBucket(account, bucketName);
    localArchives.set(key, archives);
    return archives;
}
