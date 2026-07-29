import { BlobStore } from "./blobStore";
import {
    RemoteConfig, SourceConfig, IArchives, ArchivesConfig, ArchivesSyncStatus, SyncActivity,
} from "../IArchives";
import { ROUTING_FILE, parseRoutingData, serializeRemoteConfig, normalizeSource } from "./remoteConfig";
import { createStoreSource, applySourceConfig } from "./storeSources";
import { broadcastRoutingChanged } from "./storageController";
import { assertWritesAllowed } from "./serverConfig";
import { assertValidSourceName } from "./validation";
import { getBucketFolder, listAccountStoreFolders, listBucketStoreFolders, readRoutingFromDisk, getDiskInfo, BucketDiskInfo } from "./bucketDisk";
import { scheduleBoundaryWork, reinjectIntermediates } from "./intermediateManagement";
import { SocketFunction } from "socket-function/SocketFunction";
import { StorageClientController } from "./storageClientController";
import { isSelfSource } from "./storePlan";
import { countBucketWrite, getBucketWriteStats, trackAccess, BucketWriteStats } from "./accessStats";
import { logMutation } from "./storageLogs";

/**
 * What this server HAS: the stores, by name (getStore) - made once, self-configuring from there -
 * and the three entry points a request resolves through (findBucketStore, readBucketInternal,
 * writeRoutingConfig). There is no cached bucket state: a bucket is nothing but the stores whose
 * folders share its name, listed off the disk when something genuinely needs all of them.
 */

/**
 * Every store this process runs, by folder - which IS the store's identity: account, name, bucket.
 * A store is made once, configures itself from the routing config it holds, and stays; nothing here
 * decides what it is, only that it exists.
 */
const stores = new Map<string, BlobStore>();
// The opened stores of each `${account}/${bucketName}`, by name - which buckets are ACTIVE (something touched them), for deploy handoffs and the debug pages. Purely a registry of what getStore already made.
const activeStores = new Map<string, Map<string, BlobStore>>();

export function getStore(account: string, bucketName: string, name: string, callerNodeId?: string): BlobStore {
    // The one place a name becomes a folder, so the one place it is validated (it can come straight off the wire)
    assertValidSourceName(name);
    let folder = getBucketFolder(name, account, bucketName);
    let existing = stores.get(folder);
    if (existing) return existing;
    console.log(`Opening store ${JSON.stringify(name)} of bucket ${account}/${bucketName} (folder ${folder})`);
    let store = new BlobStore(folder, name, {
        // Which entries in ITS routing config are this server's copy of it
        isSelf: source => isSelfSource(source, account, bucketName),
        createSource: config => createStoreSource({ sourceConfig: config.sourceConfig, folder, writeDelay: config.writeDelay }),
        applySource: (source, sourceConfig, writeDelay) => applySourceConfig(source, sourceConfig, writeDelay),
        onWriteCounted: (kind, bytes) => countBucketWrite(`${account}/${bucketName}`, kind, bytes),
        onSyncTransfer: (operation, path, bytes) => {
            trackAccess({ account, operation, path: `${bucketName}/${path}`, size: bytes });
            // Every synchronization write is logged per file, exactly like client mutations - the log is the full account of what moved
            logMutation({ op: operation, account, bucketName, store: name, path, size: bytes });
        },
        resolveSourceUrl: resolveSourceArchives,
        // The store is the one that knows when a config landed, and a config with upcoming windows is what boundary scans are armed from
        onRoutingApplied: routing => scheduleBoundaryWork(account, bucketName, routing),
        // The store was created by this caller's request, so the caller knows exactly what config it intended for this name - the store asks it when its own folder holds no configuration (see BlobStore.init)
        requestRoutingConfig: callerNodeId && (async () => await StorageClientController.nodes[callerNodeId].getRoutingConfigForName({ account, bucketName, name })) || undefined,
    });
    stores.set(folder, store);
    let key = `${account}/${bucketName}`;
    let byName = activeStores.get(key);
    if (!byName) {
        byName = new Map();
        activeStores.set(key, byName);
    }
    byName.set(name, store);
    // Lazy init would leave a store nothing has touched sitting inert - no index loaded, no config applied, nothing synchronizing - while its folder is full of files
    void store.init().catch((e: Error) => console.error(`Initializing store ${JSON.stringify(name)} of bucket ${account}/${bucketName} failed: ${e.stack ?? e}`));
    return store;
}

/** The store serving a request: the one the client's selected entry NAMES. Account, name, and bucket ARE the folder, so this is a direct lookup, never a search of what exists - and a name this server has never seen is CREATED, never rejected, because asking for a name is the instruction to have that store (one name, one folder, one index; it configures itself once the routing config lands in it). Nothing else about the request is compared - not the window, not the route, not the flags - which is the whole point of naming it: a client a config version behind on some flag still reaches the right store. */
export function findBucketStore(account: string, bucketName: string, sourceConfig: SourceConfig | undefined): BlobStore {
    if (!sourceConfig) {
        throw new Error(`No remote source configuration was provided for bucket ${account}/${bucketName}: every request must say which configured source it selected`);
    }
    // The caller's id, so a store this request CREATES can ask that caller for the config it intended (a store only ever exists because a config names it, and the requester holds that config)
    let callerNodeId: string | undefined;
    try {
        callerNodeId = SocketFunction.getCaller()?.nodeId;
    } catch { }
    return getStore(account, bucketName, sourceConfig.name, callerNodeId);
}

/** The stores of a bucket as the DISK records them (a bucket is nothing more than the store folders sharing its name), opened - so the ones that weren't running yet start synchronizing. Empty when the bucket does not exist here. */
export async function getBucketStores(account: string, bucketName: string): Promise<{ name: string; store: BlobStore }[]> {
    let folders = await listBucketStoreFolders(account, bucketName);
    return folders.map(x => ({ name: x.name, store: getStore(account, bucketName, x.name) }));
}

async function requireBucketStores(account: string, bucketName: string): Promise<{ name: string; store: BlobStore }[]> {
    let list = await getBucketStores(account, bucketName);
    if (!list.length) {
        throw new Error(`Bucket does not exist on this server: ${account}/${bucketName}. Write its routing config to ${JSON.stringify(ROUTING_FILE)} to create it.`);
    }
    return list;
}

/** Internal (store-to-store) reads skip store selection entirely: the caller is another store whose index says this MACHINE holds the bytes - the persisted holder identity is just a URL, which cannot name a store. Whichever store's folder has the newest copy answers. */
export async function readBucketInternal(account: string, bucketName: string, config: { path: string; range?: { start: number; end: number }; includeTombstones?: boolean }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
    let bucketStores = await requireBucketStores(account, bucketName);
    let results = await Promise.all(bucketStores.map(s => s.store.get2({ path: config.path, range: config.range, includeTombstones: config.includeTombstones, internal: true })));
    let best: { data: Buffer; writeTime: number; size: number } | undefined;
    for (let result of results) {
        if (result && (!best || result.writeTime > best.writeTime)) {
            best = result;
        }
    }
    return best;
}

function aggregateArchivesConfig(bucketStores: BlobStore[], routing: RemoteConfig | undefined): ArchivesConfig {
    let index = { fileCount: 0, byteCount: 0 };
    let markedIndex: { fileCount: number; byteCount: number; oldestDeleteTime?: number } = { fileCount: 0, byteCount: 0 };
    let indexSources: { debugName: string; fileCount: number; byteCount: number }[] = [];
    let syncing: SyncActivity[] = [];
    let readerDiskLimit: number | undefined;
    for (let store of bucketStores) {
        let progress = store.getSyncProgress();
        index.fileCount += progress.index.fileCount;
        index.byteCount += progress.index.byteCount;
        markedIndex.fileCount += progress.marked.fileCount;
        markedIndex.byteCount += progress.marked.byteCount;
        if (progress.marked.oldestDeleteTime !== undefined && (markedIndex.oldestDeleteTime === undefined || progress.marked.oldestDeleteTime < markedIndex.oldestDeleteTime)) {
            markedIndex.oldestDeleteTime = progress.marked.oldestDeleteTime;
        }
        indexSources.push(...progress.sources);
        syncing.push(...progress.syncing);
        readerDiskLimit = readerDiskLimit || progress.readerDiskLimit;
    }
    return {
        // Every store is index-backed, so the change feed is always native
        supportsChangesAfter: true,
        remoteConfig: routing,
        index,
        markedIndex,
        indexSources,
        readerDiskLimit,
        syncing,
    };
}

export async function getBucketArchivesConfig(account: string, bucketName: string): Promise<ArchivesConfig> {
    let bucketStores = await requireBucketStores(account, bucketName);
    let routing = await readRoutingFromDisk(account, bucketName);
    return aggregateArchivesConfig(bucketStores.map(x => x.store), routing);
}

export async function bucketSyncStatus(account: string, bucketName: string): Promise<ArchivesSyncStatus> {
    let bucketStores = await requireBucketStores(account, bucketName);
    let statuses = await Promise.all(bucketStores.map(s => s.store.getSyncStatus()));
    return {
        allScansComplete: statuses.every(x => x.allScansComplete),
        indexSize: statuses.reduce((sum, x) => sum + x.indexSize, 0),
        sources: statuses.flatMap(x => x.sources),
    };
}

export async function debugBucketIndexTotals(account: string, bucketName: string): Promise<{ fileCount: number; byteCount: number; sources: { debugName: string; fileCount: number; byteCount: number }[] }> {
    let bucketStores = await requireBucketStores(account, bucketName);
    let totals = await Promise.all(bucketStores.map(s => s.store.computeIndexTotals()));
    return {
        fileCount: totals.reduce((sum, x) => sum + x.fileCount, 0),
        byteCount: totals.reduce((sum, x) => sum + x.byteCount, 0),
        sources: totals.flatMap(x => x.sources),
    };
}

const resolvedSourceArchives = new Map<string, IArchives>();
/** A cached IArchives for a persisted source identity: a routing URL (hosted/backblaze) or a disk folder path - the form BlobStore's sources list stores. Configuration (valid windows, routes) decides WHEN a source should be used; for reading bytes the index says a source holds, the URL alone is enough - even for sources no longer in any config. */
export function resolveSourceArchives(url: string): IArchives {
    let existing = resolvedSourceArchives.get(url);
    if (existing) return existing;
    let sourceConfig: SourceConfig | undefined;
    if (url.startsWith("https://")) {
        // The config is fabricated from the bare URL and can never exact-match a server's entries - which is fine, because holder reads are internal reads, and internal reads never select a store (see readBucketInternal)
        sourceConfig = normalizeSource(url);
    }
    let archives = createStoreSource({ sourceConfig, folder: url });
    resolvedSourceArchives.set(url, archives);
    return archives;
}

/**
 * Writing the routing config is a write like any other: it goes into a store, and the store applies
 * it to itself and lets its peers pull it. The only thing that happens here is picking WHICH store,
 * because the writer names a source and a source names a store.
 *
 * In-flight switchover windows are re-injected first (see intermediateManagement): an operator's
 * config knows nothing about a switchover that is happening right now, and writing it as-is would
 * cancel it mid-flight.
 */
export async function writeRoutingConfig(account: string, bucketName: string, name: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
    assertWritesAllowed();
    let store = getStore(account, bucketName, name);
    let incoming = parseRoutingData(data);
    if (!incoming) {
        throw new Error(`Routing config write rejected - not a parseable config. The data written for ${account}/${bucketName} (store ${JSON.stringify(name)}) is not a valid { version?, sources: [...] } JSON config (${data.length} bytes)`);
    }
    let current = await readRoutingFromDisk(account, bucketName);
    let stored = reinjectIntermediates(current, incoming);
    let storedData = Buffer.from(serializeRemoteConfig(stored));
    await store.set({ path: ROUTING_FILE, data: storedData, lastModified: config?.lastModified });
    logMutation({ op: "routingConfig", account, bucketName, store: name, path: ROUTING_FILE, size: storedData.length, writeTime: config?.lastModified });
    broadcastRoutingChanged();
}

/** Which buckets this process currently has active (some store of theirs was opened) - what a deploy successor asks its predecessor for, so it activates exactly the buckets that are actually in use. */
export function getActiveBucketKeys(): { account: string; bucketName: string }[] {
    return [...activeStores.keys()].map(key => {
        let slash = key.indexOf("/");
        return { account: key.slice(0, slash), bucketName: key.slice(slash + 1) };
    });
}

export type ServerBucketInfo = {
    bucketName: string;
    active: boolean;
    /** Where the bucket's data lives on this server */
    folder: string;
    /** The drive that folder is on. Buckets sharing a drive report the same numbers. */
    disk?: BucketDiskInfo;
    diskError?: string;
    writeStats?: BucketWriteStats;
    config?: ArchivesConfig;
    error?: string;
};

export type ActiveBucketInfo = {
    folder: string;
    /** The bucket's routing config, the newest copy among its stores. Absent when none of them has one yet. */
    routing?: RemoteConfig;
    config: ArchivesConfig;
};

/** The state of ONE active bucket. Returns an error string when the bucket is not active here, which is the normal state for a bucket nothing has accessed since startup. */
export async function debugGetActiveBucket(account: string, bucketName: string): Promise<ActiveBucketInfo | string> {
    let key = `${account}/${bucketName}`;
    let opened = activeStores.get(key);
    if (!opened || !opened.size) {
        return `Bucket ${key} is not active on this server (a bucket activates on first access)`;
    }
    let bucketStores = [...opened.values()];
    let routing = await readRoutingFromDisk(account, bucketName);
    return { folder: bucketStores[0].folder, routing, config: aggregateArchivesConfig(bucketStores, routing) };
}

/** Loads every store of a bucket that exists on this server's disk into memory, which starts their synchronization and window timers, and returns the bucket's state. Nothing is written and no other server is contacted - unlike building an ArchivesChain for it, which would probe every source and could write the routing config. Already-active buckets just return their state. */
export async function activateBucket(account: string, bucketName: string): Promise<ActiveBucketInfo | string> {
    let key = `${account}/${bucketName}`;
    let wasActive = activeStores.has(key);
    let bucketStores = await getBucketStores(account, bucketName);
    if (!bucketStores.length) {
        return `Bucket ${key} does not exist on this server (it has no store folders under ${getBucketFolder("<name>", account, bucketName)})`;
    }
    // Wait for the indexes to load, so the totals we return are the real ones rather than zeroes from stores that have not read their index yet. The source scans keep running in the background.
    for (let s of bucketStores) {
        await s.store.init();
    }
    if (!wasActive) {
        console.log(`Activated bucket ${key} on request: its ${bucketStores.length} store(s) are now loaded and synchronizing`);
    }
    let routing = await readRoutingFromDisk(account, bucketName);
    return { folder: bucketStores[0].store.folder, routing, config: aggregateArchivesConfig(bucketStores.map(x => x.store), routing) };
}

export async function debugListAccountBuckets(account: string): Promise<ServerBucketInfo[]> {
    let start = Date.now();
    // The disk is the record: a bucket exists here when it has at least one store folder, and several names for one bucket are still one bucket
    let folders = await listAccountStoreFolders(account);
    let byBucket = new Map<string, string>();
    for (let store of folders) {
        if (byBucket.has(store.bucketName)) continue;
        byBucket.set(store.bucketName, store.folder);
    }
    let names = [...byBucket.keys()];
    try {
        return await Promise.all(names.map(async bucketName => {
            let key = `${account}/${bucketName}`;
            let folder = byBucket.get(bucketName) || "";
            let base: ServerBucketInfo = { bucketName, active: activeStores.has(key), folder };
            base.disk = await getDiskInfo(folder).catch((e: Error) => {
                base.diskError = String(e.stack ?? e).slice(0, 500);
                return undefined;
            });
            base.writeStats = getBucketWriteStats(key);
            try {
                let routing = await readRoutingFromDisk(account, bucketName);
                if (base.active) {
                    let opened = [...(activeStores.get(key)?.values() || [])];
                    return { ...base, config: aggregateArchivesConfig(opened, routing) };
                }
                if (!routing) {
                    return { ...base, error: `No routing file (${ROUTING_FILE}) in any of its stores` };
                }
                return { ...base, config: { remoteConfig: routing } };
            } catch (e) {
                return { ...base, error: String((e as Error).stack ?? e).slice(0, 500) };
            }
        }));
    } finally {
        console.log(`debugListAccountBuckets(${account}) took ${Date.now() - start}ms for ${names.length} buckets`);
    }
}
