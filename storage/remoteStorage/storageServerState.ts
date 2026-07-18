import path from "path";
import { getFileStorageNested2 } from "../FileFolderAPI";
import { TransactionStorage } from "../TransactionStorage";
import { JSONStorage } from "../JSONStorage";
import { ArchivesDisk } from "../ArchivesDisk";
import { BlobStore, IBucketStore } from "./blobStore";
import {
    RemoteConfig, HostedConfig, IArchives, ArchivesSource, ArchiveFileInfo, ArchivesConfig,
    ArchivesSyncStatus, FULL_VALID_WINDOW,
    WRITE_PAST_WINDOW_GRACE, STORAGE_WRONG_VALID_WINDOW, STORAGE_WRONG_ROUTE, FULL_ROUTE,
} from "../IArchives";
import { ROUTING_FILE, parseRoutingData, parseHostedUrl, buildFileUrl, getConfigVersion, getRoute, routeContains, routeIntersection } from "./remoteConfig";
import { createApiArchives } from "./createArchives";
import type { IStorage } from "../IStorage";
import type { AccessRequest, TrustRecord } from "./storageController";
import { getArg } from "./cliArgs";

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
// setTrustedMachines is called by consumers BEFORE starting the server, so when the config isn't
// set yet we fall back to the same --folder arg the CLI starts the server with.
function getStorageFolder(): string {
    let config = getStorageServerConfigOptional();
    if (config) return config.folder;
    let folder = getArg("folder");
    if (!folder) {
        throw new Error(`Storage server is not initialized and there is no --folder arg, so the storage folder is unknown`);
    }
    return path.resolve(folder);
}

const systemStorages = new Map<string, Promise<IStorage<unknown>>>();
function getSystemStorage<T>(name: string): Promise<IStorage<T>> {
    let storage = systemStorages.get(name);
    if (!storage) {
        storage = (async () => {
            let root = await getFileStorageNested2(getStorageFolder());
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

/** Makes machineIds the complete trust list for the account: machines not in the list lose access, machines already trusted keep their existing record, and missing ones are added. */
export async function setTrustedMachines(config: { account: string; machineIds: string[] }): Promise<void> {
    let trust = await getTrust();
    let prefix = `${config.account}|`;
    let desired = new Set(config.machineIds);
    for (let key of await trust.getKeys()) {
        if (!key.startsWith(prefix)) continue;
        let machineId = key.slice(prefix.length);
        if (desired.has(machineId)) {
            desired.delete(machineId);
            continue;
        }
        console.log(`Removing trust for machine ${machineId} on account ${config.account}`);
        await trust.remove(key);
    }
    for (let machineId of desired) {
        console.log(`Adding trust for machine ${machineId} on account ${config.account}`);
        await trust.set(`${prefix}${machineId}`, { account: config.account, machineId, ip: "", time: Date.now() });
    }
}

// ── buckets ──

export type LoadedBucket = {
    account: string;
    bucketName: string;
    // The bucket's parsed routing config (the contents of ROUTING_FILE)
    routing: RemoteConfig;
    // JSON of routing, for change detection
    routingJSON: string;
    // ALL of our own entries in routing.sources (this bucket on this server). More than one when
    // the bucket's options change over time - one entry per valid window (e.g. immutable dropped,
    // or fast enabled, starting at a scheduled instant).
    selfEntries: HostedConfig[];
    // The entry valid when the store was built - the structural options (rawDisk, which entries
    // are downstream). Per-write options (fast/immutable) are instead evaluated at each write's
    // time, see getWriteConfig/assertMutable. undefined when the config doesn't mention us.
    self: HostedConfig | undefined;
    store: IBucketStore;
};

const buckets = new Map<string, Promise<LoadedBucket | undefined>>();

// setTimeout cannot represent longer delays; more distant window boundaries re-check after this
const MAX_REBUILD_TIMER_DELAY = 2 ** 31 - 1;
// Rebuild slightly after the boundary, so the newly-valid entry is unambiguously active
const REBUILD_BOUNDARY_BUFFER = 1000;

function getBucketFolder(account: string, bucketName: string): string {
    return path.join(getStorageServerConfig().folder, "buckets2", account, bucketName);
}

function findSelfIndexes(routing: RemoteConfig, account: string, bucketName: string): number[] {
    let { domain, port } = getStorageServerConfig();
    let indexes: number[] = [];
    for (let i = 0; i < routing.sources.length; i++) {
        let source = routing.sources[i];
        if (typeof source === "string" || source.type !== "remote") continue;
        let parsed = parseHostedUrl(source.url);
        if (parsed.address === domain && parsed.port === port && parsed.account === account && parsed.bucketName === bucketName) {
            indexes.push(i);
        }
    }
    return indexes;
}

// The entry whose valid window contains the time (among the entries covering the key's route,
// when one is given - a server can hold different shards with different options). Half-open
// ([start, end)), so clean breaks resolve unambiguously. Falls back to the nearest window when
// none contains the time - gaps shouldn't exist, but a write must still resolve to SOME
// configuration.
function selectEntryAt(entries: HostedConfig[], time: number, route?: number): HostedConfig | undefined {
    if (route !== undefined) {
        let covering = entries.filter(x => routeContains(x.route, route));
        if (covering.length) {
            entries = covering;
        }
    }
    let containing = entries.find(x => x.validWindow[0] <= time && time < x.validWindow[1]);
    if (containing) return containing;
    let best: HostedConfig | undefined;
    let bestDistance = Infinity;
    for (let entry of entries) {
        let distance = Math.min(Math.abs(time - entry.validWindow[0]), Math.abs(time - entry.validWindow[1]));
        if (distance < bestDistance) {
            bestDistance = distance;
            best = entry;
        }
    }
    return best;
}

// Bucket options can change over time (multiple self entries with different valid windows), and
// the structural ones (rawDisk, the downstream list) are baked into the store - so the store is
// rebuilt shortly after each of our window boundaries passes, making the newly-valid entry apply.
function scheduleWindowBoundaryRebuild(loaded: LoadedBucket): void {
    let now = Date.now();
    let boundaries = loaded.selfEntries.flatMap(x => x.validWindow).filter(t => t > now);
    if (!boundaries.length) return;
    let nextBoundary = Math.min(...boundaries);
    let key = `${loaded.account}/${loaded.bucketName}`;
    let timer = setTimeout(() => {
        void (async () => {
            // A routing change may have already replaced this store; only IT gets a boundary timer
            let current = await buckets.get(key);
            if (current !== loaded) return;
            if (Date.now() < nextBoundary) {
                scheduleWindowBoundaryRebuild(loaded);
                return;
            }
            await scheduleRoutingReload(loaded.account, loaded.bucketName, { force: true });
        })();
    }, Math.min(nextBoundary - now + REBUILD_BOUNDARY_BUFFER, MAX_REBUILD_TIMER_DELAY));
    (timer as { unref?: () => void }).unref?.();
}

function buildBucket(account: string, bucketName: string, routing: RemoteConfig): LoadedBucket {
    let folder = getBucketFolder(account, bucketName);
    let selfIndexes = findSelfIndexes(routing, account, bucketName);
    let selfEntries = selfIndexes.map(i => routing.sources[i] as HostedConfig);
    let self = selectEntryAt(selfEntries, Date.now());
    let selfIndex = -1;
    if (self) {
        selfIndex = routing.sources.indexOf(self);
    }
    let store: IBucketStore;
    if (self?.rawDisk) {
        store = new ArchivesDisk(folder);
    } else {
        // Our own disk is the base source; only the routing entries DOWNSTREAM from us (after our
        // currently-valid entry) become synchronization sources. Upstream sources sync from us, so
        // writing to or scanning them would just echo our own data back (and make our availability
        // depend on theirs). A server NOT in the list has been removed from the bucket: it keeps
        // its disk data (the config may re-add it), but stops all synchronization - no one
        // contacts a removed source, and scanning/pushing as if we were still one would fight the
        // real chain. The config-level validWindow rides on each ArchivesSource; the disk source
        // shares our currently-valid entry's window (it holds our copy of the data).
        let ownIndexes = new Set(selfIndexes);
        // Our own disk gets no route filter: everything it holds is ours to index and serve
        let sources: ArchivesSource[] = [{
            source: new ArchivesDisk(folder),
            validWindow: self?.validWindow || FULL_VALID_WINDOW,
        }];
        if (selfIndex === -1) {
            console.log(`This server is not in the routing config for bucket ${account}/${bucketName}; keeping its data on disk but no longer synchronizing it`);
        } else {
            for (let i = selfIndex + 1; i < routing.sources.length; i++) {
                let source = routing.sources[i];
                if (typeof source === "string" || ownIndexes.has(i)) continue;
                // Disjoint-shard sources never talk to each other; a partial overlap syncs only
                // the intersection (scans ignore the rest, writes only send matching keys)
                let sharedRoute = routeIntersection(self?.route, source.route);
                if (!sharedRoute) continue;
                // A bounded-cache server (noFullSync on our own entry) must not full-sync from
                // ANY source, or its disk would fill regardless of the limit
                sources.push({ source: createApiArchives(source), validWindow: source.validWindow, route: sharedRoute, noFullSync: source.noFullSync || self?.noFullSync });
            }
        }
        store = new BlobStore(folder, sources, {
            onIndexChanged: key => {
                // Fires for our own routing writes AND routing files pulled in via synchronization
                // (only ever newer ones, see IArchives.set) — either way, apply the new config
                if (key !== ROUTING_FILE) return;
                void scheduleRoutingReload(account, bucketName);
            },
            readerDiskLimit: self?.readerDiskLimit,
        });
    }
    let loaded: LoadedBucket = { account, bucketName, routing, routingJSON: JSON.stringify(routing), selfEntries, self, store };
    scheduleWindowBoundaryRebuild(loaded);
    return loaded;
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
function scheduleRoutingReload(account: string, bucketName: string, config?: { force?: boolean }): Promise<void> {
    let key = `${account}/${bucketName}`;
    let next = (routingReloads.get(key) || Promise.resolve())
        .then(() => checkRoutingChanged(account, bucketName, config?.force))
        .catch(e => console.error(`Reloading routing config for bucket ${key} failed:`, e));
    routingReloads.set(key, next);
    return next;
}

async function checkRoutingChanged(account: string, bucketName: string, force?: boolean): Promise<void> {
    let key = `${account}/${bucketName}`;
    let loaded = await buckets.get(key);
    if (!loaded) return;
    // get() cache-reads the file onto our disk when a remote source holds it, so the bucket still
    // exists after a restart
    let data = await loaded.store.get(ROUTING_FILE);
    if (!data) return;
    let routing = parseRoutingData(data);
    if (!force && JSON.stringify(routing) === loaded.routingJSON) return;
    if (force) {
        console.log(`Rebuilding the store for bucket ${key} (a valid window boundary passed)`);
    } else {
        console.log(`Routing config changed for bucket ${key}, rebuilding its store`);
    }
    if (loaded.store instanceof BlobStore) {
        await loaded.store.dispose();
    }
    buckets.set(key, Promise.resolve(buildBucket(account, bucketName, routing)));
}

// Per-write options are evaluated at the WRITE's time (and the key's route), not the current
// config: the write time is stamped exactly once (at the first node that receives the write) and
// propagates with the data, so every node resolves the same self entry - and the same options.
function getWriteConfig(bucket: LoadedBucket, writeTime: number, route: number): { fast?: boolean; writeDelay?: number } {
    let self = selectEntryAt(bucket.selfEntries, writeTime, route);
    return { fast: self?.fast, writeDelay: self?.writeDelay };
}

export async function assertMutable(bucket: LoadedBucket, filePath: string, writeTime: number): Promise<void> {
    let self = selectEntryAt(bucket.selfEntries, writeTime, getRoute(filePath));
    if (!self?.immutable) return;
    if (await bucket.store.getInfo(filePath)) {
        throw new Error(`Bucket ${bucket.account}/${bucket.bucketName} is immutable (at write time ${writeTime}) and ${JSON.stringify(filePath)} already exists, so it cannot be written to`);
    }
}

// Routing writes are serialized per bucket, so two concurrent creates can't both build a store
// (the loser's store would leak with its sync loops running forever)
const routingWrites = new Map<string, Promise<void>>();

async function writeRoutingConfig(account: string, bucketName: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
    let key = `${account}/${bucketName}`;
    // Validates before storing anything, so a bad config can't brick the bucket
    let incoming = parseRoutingData(data);
    let loaded = await getLoadedBucket(account, bucketName);
    if (!loaded) {
        await new ArchivesDisk(getBucketFolder(account, bucketName)).set(ROUTING_FILE, data, { lastModified: config?.lastModified });
        buckets.set(key, Promise.resolve(buildBucket(account, bucketName, incoming)));
        console.log(`Created bucket ${key}`);
        return;
    }
    // A changed config must carry a higher version than the one currently stored — otherwise two
    // clients with different configs at the same version would keep clobbering each other. Same
    // content at any version is a harmless no-op and is allowed through.
    if (JSON.stringify(incoming) !== loaded.routingJSON && getConfigVersion(incoming) <= getConfigVersion(loaded.routing)) {
        throw new Error(`Cannot update routing config for bucket ${key}: the new config differs from the current one but its version (${getConfigVersion(incoming)}) is not greater than the current version (${getConfigVersion(loaded.routing)}). Increment the version to update it. Current: ${loaded.routingJSON}. Attempted: ${JSON.stringify(incoming)}`);
    }
    // Routing writes bypass fast mode (the config must apply immediately and survive a crash)
    // and ignore immutable (the routing file must always stay updatable). An older lastModified
    // no-ops inside set, in which case the reload below sees no change.
    await loaded.store.set(ROUTING_FILE, data, { lastModified: config?.lastModified });
    await scheduleRoutingReload(account, bucketName);
}

export async function writeBucketFile(account: string, bucketName: string, filePath: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
    assertWritesAllowed();
    if (filePath === ROUTING_FILE) {
        let key = `${account}/${bucketName}`;
        let run = (routingWrites.get(key) || Promise.resolve()).then(() => writeRoutingConfig(account, bucketName, data, config));
        // The chain must survive a failed write, so the stored link swallows the error (the caller
        // still gets it from run)
        routingWrites.set(key, run.then(() => { }, () => { }));
        return await run;
    }
    let loaded = await getLoadedBucket(account, bucketName);
    if (!loaded) {
        throw new Error(`Bucket ${account}/${bucketName} does not exist. Write its routing config to ${JSON.stringify(ROUTING_FILE)} to create it.`);
    }
    // The write time is determined exactly once, HERE at the first node that receives the write;
    // it propagates as lastModified, so every node evaluates the bucket options at the same instant
    let writeTime = config?.lastModified || Date.now();
    // Only freshly-stamped writes are checked: a write with an explicit lastModified is
    // synchronization/backfill (old data legitimately lands on sources whose window has moved on),
    // but a fresh write reaching us outside our windows/routes means the client resolved its
    // target from a stale view - it must re-resolve and retry at the correct source.
    let route = getRoute(filePath);
    if (!config?.lastModified && loaded.selfEntries.length) {
        let timeValid = loaded.selfEntries.filter(x => writeTime >= x.validWindow[0] - WRITE_PAST_WINDOW_GRACE && writeTime <= x.validWindow[1] + WRITE_PAST_WINDOW_GRACE);
        if (!timeValid.length) {
            throw new Error(`${STORAGE_WRONG_VALID_WINDOW} This server is not a valid write target at ${writeTime} for bucket ${account}/${bucketName} (our valid windows: ${JSON.stringify(loaded.selfEntries.map(x => x.validWindow))}). Re-resolve the currently valid source and retry.`);
        }
        if (!timeValid.some(x => routeContains(x.route, route))) {
            throw new Error(`${STORAGE_WRONG_ROUTE} This server does not handle route ${route} (key ${JSON.stringify(filePath)}) for bucket ${account}/${bucketName} (our routes at this time: ${JSON.stringify(timeValid.map(x => x.route || FULL_ROUTE))}). Re-resolve the source for this key and retry.`);
        }
    }
    await assertMutable(loaded, filePath, writeTime);
    await loaded.store.set(filePath, data, { ...getWriteConfig(loaded, writeTime, route), lastModified: writeTime });
}

export async function deleteBucketFile(account: string, bucketName: string, filePath: string): Promise<void> {
    if (filePath === ROUTING_FILE) {
        throw new Error(`The routing config ${JSON.stringify(ROUTING_FILE)} cannot be deleted (overwrite it to change the bucket's configuration)`);
    }
    let loaded = await getLoadedBucket(account, bucketName);
    if (!loaded) return;
    await loaded.store.del(filePath, getWriteConfig(loaded, Date.now(), getRoute(filePath)));
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
    public async get2(fileName: string, config?: { range?: { start: number; end: number } }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
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
        await assertMutable(bucket, config.path, Date.now());
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
        let progress = bucket?.store.getSyncProgress?.();
        return {
            supportsChangesAfter: !bucket || !!bucket.store.getChangesAfter,
            remoteConfig: bucket?.routing,
            index: progress?.index,
            indexSources: progress?.sources,
            readerDiskLimit: progress?.readerDiskLimit,
            syncing: progress?.syncing,
        };
    }
    public async hasWriteAccess(): Promise<boolean> {
        return true;
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
