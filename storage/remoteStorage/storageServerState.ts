import path from "path";
import fs from "fs";
import { lazy } from "socket-function/src/caching";
import { runInfinitePoll } from "socket-function/src/batching";
import { getFileStorageNested2 } from "../FileFolderAPI";
import { TransactionStorage } from "../TransactionStorage";
import { JSONStorage } from "../JSONStorage";
import { ArchivesDisk } from "../ArchivesDisk";
import { BlobStore, IBucketStore, DEFAULT_FAST_WRITE_DELAY, WINDOW_END_FLUSH_MARGIN } from "./blobStore";
import {
    RemoteConfig, HostedConfig, BackblazeConfig, IArchives, ArchivesSource, ArchiveFileInfo, ArchivesConfig,
    ArchivesSyncStatus,
    STORAGE_WRONG_VALID_WINDOW, STORAGE_WRONG_ROUTE, FULL_ROUTE,
} from "../IArchives";
import { ROUTING_FILE, parseRoutingData, serializeRemoteConfig, parseHostedUrl, replaceHostedUrlPort, buildFileUrl, getConfigVersion, getRoute, routeContains, routeIntersection } from "./remoteConfig";
import { injectIntermediateSource, expireIntermediateSources, getIntermediateSources, findSplitUrl, nextIntermediateVersion, INTERMEDIATE_EXPIRE_GRACE } from "./intermediateSources";
import { getTakeoverIntermediate } from "./deployTakeover";
import { createApiArchives } from "./createArchives";
import type { IStorage } from "../IStorage";
import { broadcastRoutingChanged } from "./storageController";
import type { AccessRequest, TrustRecord } from "./storageController";
import { getArg } from "./cliArgs";

export type StorageServerConfig = {
    domain: string;
    port: number;
    rootDomain: string;
    sshTarget: string;
    serverCommand: string;
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
export function getStorageServerConfigOptional(): StorageServerConfig | undefined {
    return config;
}

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

export type BucketWriteStats = {
    /** Every set call the bucket accepted */
    originalWrites: number;
    originalBytes: number;
    /** What actually reached the sources. Fast writes coalesce repeated writes to the same key, so this is lower than the original counts (and is what the disk actually did). */
    flushedWrites: number;
    flushedBytes: number;
};
function emptyWriteStats(): BucketWriteStats {
    return { originalWrites: 0, originalBytes: 0, flushedWrites: 0, flushedBytes: 0 };
}
function addWriteStats(a: BucketWriteStats, b: BucketWriteStats): BucketWriteStats {
    return {
        originalWrites: a.originalWrites + b.originalWrites,
        originalBytes: a.originalBytes + b.originalBytes,
        flushedWrites: a.flushedWrites + b.flushedWrites,
        flushedBytes: a.flushedBytes + b.flushedBytes,
    };
}
function getWriteStatsStorage(): Promise<IStorage<BucketWriteStats>> {
    return getSystemStorage<BucketWriteStats>("writeStats");
}

// Counted in memory as deltas since the last flush, so counting a write never touches the disk. The flush reads the stored totals and adds the delta, which also makes it correct across restarts.
const writeStatDeltas = new Map<string, BucketWriteStats>();

async function flushWriteStats(): Promise<void> {
    if (!writeStatDeltas.size) return;
    let pending = [...writeStatDeltas];
    writeStatDeltas.clear();
    let storage = await getWriteStatsStorage();
    for (let [key, delta] of pending) {
        try {
            await storage.set(key, addWriteStats(await storage.get(key) || emptyWriteStats(), delta));
        } catch (e) {
            // Put the delta back, so a failed flush loses nothing
            writeStatDeltas.set(key, addWriteStats(writeStatDeltas.get(key) || emptyWriteStats(), delta));
            console.error(`Flushing write stats for bucket ${key} failed: ${(e as Error).stack ?? e}`);
        }
    }
}

const startWriteStatsFlushing = lazy(() => {
    runInfinitePoll(WRITE_STATS_FLUSH_INTERVAL, flushWriteStats);
});

function countBucketWrite(key: string, kind: "original" | "flushed", bytes: number): void {
    let delta = writeStatDeltas.get(key);
    if (!delta) {
        delta = emptyWriteStats();
        writeStatDeltas.set(key, delta);
    }
    if (kind === "original") {
        delta.originalWrites++;
        delta.originalBytes += bytes;
    } else {
        delta.flushedWrites++;
        delta.flushedBytes += bytes;
    }
    startWriteStatsFlushing();
}

async function getBucketWriteStats(key: string): Promise<BucketWriteStats> {
    let storage = await getWriteStatsStorage();
    let stored = await storage.get(key) || emptyWriteStats();
    let delta = writeStatDeltas.get(key);
    return delta && addWriteStats(stored, delta) || stored;
}

/** Zeroes the write statistics of every bucket in the account, including counts not yet flushed. */
export async function clearAccountWriteStats(account: string): Promise<number> {
    let storage = await getWriteStatsStorage();
    let prefix = `${account}/`;
    let cleared = 0;
    for (let key of await storage.getKeys()) {
        if (!key.startsWith(prefix)) continue;
        writeStatDeltas.delete(key);
        await storage.remove(key);
        cleared++;
    }
    for (let key of [...writeStatDeltas.keys()]) {
        if (!key.startsWith(prefix)) continue;
        writeStatDeltas.delete(key);
        cleared++;
    }
    console.log(`Cleared the write statistics of ${cleared} buckets in account ${account}`);
    return cleared;
}

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

export type LoadedBucket = {
    account: string;
    bucketName: string;
    routing: RemoteConfig;
    routingJSON: string;
    selfEntries: HostedConfig[];
    self: HostedConfig | undefined;
    store: IBucketStore;
    structureKey: string;
};

const buckets = new Map<string, Promise<LoadedBucket | undefined>>();

const MAX_REBUILD_TIMER_DELAY = 2 ** 31 - 1;
const REBUILD_BOUNDARY_BUFFER = 1000;
const WRITE_STATS_FLUSH_INTERVAL = 5 * 60 * 1000;

function getBucketFolder(account: string, bucketName: string): string {
    return path.join(getStorageServerConfig().folder, "buckets2", account, bucketName);
}

const extraListenPorts = new Set<number>();
export function addExtraListenPort(port: number): void {
    extraListenPorts.add(port);
}
export function removeExtraListenPort(port: number): void {
    extraListenPorts.delete(port);
}
function findSelfIndexes(routing: RemoteConfig, account: string, bucketName: string): number[] {
    let { domain, port } = getStorageServerConfig();
    let indexes: number[] = [];
    for (let i = 0; i < routing.sources.length; i++) {
        let source = routing.sources[i];
        if (typeof source === "string" || source.type !== "remote") continue;
        let parsed = parseHostedUrl(source.url);
        if (parsed.address !== domain || parsed.account !== account || parsed.bucketName !== bucketName) continue;
        if (parsed.port === port || extraListenPorts.has(parsed.port)) {
            indexes.push(i);
        }
    }
    return indexes;
}

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

function scheduleWindowBoundaryRebuild(loaded: LoadedBucket): void {
    let now = Date.now();
    let boundaries = loaded.selfEntries.flatMap(x => x.validWindow).filter(t => t > now);
    if (!boundaries.length) return;
    let nextBoundary = Math.min(...boundaries);
    let key = `${loaded.account}/${loaded.bucketName}`;
    let timer = setTimeout(() => {
        void (async () => {
            let current = await buckets.get(key);
            if (current !== loaded) return;
            if (Date.now() < nextBoundary) {
                scheduleWindowBoundaryRebuild(loaded);
                return;
            }
            await scheduleRoutingReload(loaded.account, loaded.bucketName, { force: true, reason: "a valid window boundary passed" });
        })();
    }, Math.min(nextBoundary - now + REBUILD_BOUNDARY_BUFFER, MAX_REBUILD_TIMER_DELAY));
    (timer as { unref?: () => void }).unref?.();
}

const BOUNDARY_SCAN_OFFSETS = [-30 * 1000, 2 * 1000, 30 * 1000];
const BOUNDARY_SCAN_LOOKBACK = DEFAULT_FAST_WRITE_DELAY + WINDOW_END_FLUSH_MARGIN;
const STARTUP_BOUNDARY_SCAN_DELAY = 30 * 1000;

const scheduledBoundaryScans = new Set<string>();
const boundaryScansRunning = new Set<string>();

function scheduleBoundaryScans(loaded: LoadedBucket): void {
    let key = `${loaded.account}/${loaded.bucketName}`;
    let now = Date.now();
    let starts = new Set<number>();
    for (let self of loaded.selfEntries) {
        let start = self.validWindow[0];
        if (start > now && start < Number.MAX_SAFE_INTEGER) {
            starts.add(start);
        }
    }
    for (let self of loaded.selfEntries) {
        let [start, end] = self.validWindow;
        if (!(start <= now && now < end) || start <= 0) continue;
        if (now - start > BOUNDARY_SCAN_LOOKBACK) continue;
        let scheduleKey = `${key}|${start}|startup`;
        if (scheduledBoundaryScans.has(scheduleKey)) continue;
        scheduledBoundaryScans.add(scheduleKey);
        let timer = setTimeout(() => {
            void runBoundaryScan(key, start, STARTUP_BOUNDARY_SCAN_DELAY, "startup+30s").catch((e: Error) => console.error(`Boundary scan for bucket ${key} failed: ${e.stack ?? e}`));
        }, STARTUP_BOUNDARY_SCAN_DELAY);
        (timer as { unref?: () => void }).unref?.();
    }
    for (let start of starts) {
        for (let offset of BOUNDARY_SCAN_OFFSETS) {
            let at = start + offset;
            if (at <= now) continue;
            let scheduleKey = `${key}|${start}|${offset}`;
            if (scheduledBoundaryScans.has(scheduleKey)) continue;
            scheduledBoundaryScans.add(scheduleKey);
            let arm = () => {
                let timer = setTimeout(() => {
                    if (Date.now() < at) {
                        arm();
                        return;
                    }
                    void runBoundaryScan(key, start, offset).catch((e: Error) => console.error(`Boundary scan for bucket ${key} failed: ${e.stack ?? e}`));
                }, Math.min(at - Date.now(), MAX_REBUILD_TIMER_DELAY));
                (timer as { unref?: () => void }).unref?.();
            };
            arm();
        }
    }
}

async function runBoundaryScan(bucketKey: string, windowStart: number, offset: number, offsetLabel?: string): Promise<void> {
    let label = `bucket ${bucketKey}, window starting ${new Date(windowStart).toISOString()}, offset ${offsetLabel || `${offset / 1000}s`}`;
    if (boundaryScansRunning.has(bucketKey)) {
        console.log(`Skipping boundary scan (${label}): the previous boundary scan is still running`);
        return;
    }
    boundaryScansRunning.add(bucketKey);
    try {
        let loaded = await buckets.get(bucketKey);
        if (!loaded) return;
        let store = loaded.store;
        if (!(store instanceof BlobStore)) return;
        let effective = loaded.routing;
        let selfIndexes = findSelfIndexes(effective, loaded.account, loaded.bucketName);
        let selfIndexSet = new Set(selfIndexes);
        let selves = selfIndexes.map(i => effective.sources[i] as HostedConfig).filter(x => x.validWindow[0] === windowStart);
        if (!selves.length) return;
        let prevTime = windowStart - 1;
        let needDiskScan = false;
        let remoteOwners = new Map<number, [number, number]>();
        for (let self of selves) {
            let selfRoute = self.route || FULL_ROUTE;
            let idx = effective.sources.indexOf(self);
            let shadowed = false;
            for (let j = 0; j < idx; j++) {
                let other = effective.sources[j];
                if (typeof other === "string") continue;
                let [ws, we] = other.validWindow;
                if (!(ws <= windowStart && windowStart < we)) continue;
                let r = other.route || FULL_ROUTE;
                if (r[0] <= selfRoute[0] && selfRoute[1] <= r[1]) {
                    shadowed = true;
                    break;
                }
            }
            if (shadowed) continue;
            let uncovered: [number, number][] = [[selfRoute[0], selfRoute[1]]];
            for (let j = 0; j < effective.sources.length && uncovered.length; j++) {
                let other = effective.sources[j];
                if (typeof other === "string") continue;
                let [ws, we] = other.validWindow;
                if (!(ws <= prevTime && prevTime < we)) continue;
                let r = other.route || FULL_ROUTE;
                let remaining: [number, number][] = [];
                let claimed: [number, number] | undefined;
                for (let u of uncovered) {
                    let inter = routeIntersection(u, r);
                    if (!inter) {
                        remaining.push(u);
                        continue;
                    }
                    claimed = claimed && [Math.min(claimed[0], inter[0]), Math.max(claimed[1], inter[1])] as [number, number] || inter;
                    if (u[0] < inter[0]) remaining.push([u[0], inter[0]]);
                    if (inter[1] < u[1]) remaining.push([inter[1], u[1]]);
                }
                uncovered = remaining;
                if (!claimed) continue;
                if (selfIndexSet.has(j)) {
                    needDiskScan = true;
                } else {
                    let existing = remoteOwners.get(j);
                    remoteOwners.set(j, existing && [Math.min(existing[0], claimed[0]), Math.max(existing[1], claimed[1])] as [number, number] || claimed);
                }
            }
        }
        if (!needDiskScan && !remoteOwners.size) return;
        console.log(`Boundary scan (${label}): diskScan=${needDiskScan}, remote previous-window owners: ${remoteOwners.size}`);
        if (needDiskScan) {
            await store.rescanBase();
        }
        let since = windowStart - BOUNDARY_SCAN_LOOKBACK;
        for (let [sourceIndex, route] of remoteOwners) {
            let ownerSource = effective.sources[sourceIndex];
            if (typeof ownerSource === "string") continue;
            try {
                await store.boundaryScanRemote(createApiArchives(ownerSource), { since, route });
            } catch (e) {
                console.error(`Boundary scan (${label}) of previous-window owner (source index ${sourceIndex}) failed: ${(e as Error).stack ?? e}`);
            }
        }
    } finally {
        boundaryScansRunning.delete(bucketKey);
    }
}

type StorePlan = {
    selfEntries: HostedConfig[];
    self: HostedConfig | undefined;
    rawDisk: boolean;
    sourceSpecs: { sourceConfig?: HostedConfig | BackblazeConfig; validWindow: [number, number]; route?: [number, number]; noFullSync?: boolean }[];
    readerDiskLimit?: number;
    structureKey: string;
};

function sourceIdentity(sourceConfig: HostedConfig | BackblazeConfig | undefined): string {
    if (!sourceConfig) return "disk";
    return JSON.stringify({ ...sourceConfig, validWindow: undefined, route: undefined });
}

function computeStorePlan(account: string, bucketName: string, routing: RemoteConfig): StorePlan {
    let selfIndexes = findSelfIndexes(routing, account, bucketName);
    let selfEntries = selfIndexes.map(i => routing.sources[i] as HostedConfig);
    let self = selectEntryAt(selfEntries, Date.now());
    let selfIndex = -1;
    if (self) {
        selfIndex = routing.sources.indexOf(self);
    }
    let diskWindow: [number, number] = [0, 0];
    if (self) {
        let [start, end] = self.validWindow;
        let merged = true;
        while (merged) {
            merged = false;
            for (let entry of selfEntries) {
                let [entryStart, entryEnd] = entry.validWindow;
                if (entryStart > end || entryEnd < start) continue;
                if (entryStart < start || entryEnd > end) {
                    start = Math.min(start, entryStart);
                    end = Math.max(end, entryEnd);
                    merged = true;
                }
            }
        }
        diskWindow = [start, end];
    }
    let ownIndexes = new Set(selfIndexes);
    let sourceSpecs: StorePlan["sourceSpecs"] = [{
        validWindow: diskWindow,
    }];
    if (selfIndex !== -1) {
        for (let i = selfIndex + 1; i < routing.sources.length; i++) {
            let source = routing.sources[i];
            if (typeof source === "string" || ownIndexes.has(i)) continue;
            let sharedRoute = routeIntersection(self?.route, source.route);
            if (!sharedRoute) continue;
            sourceSpecs.push({ sourceConfig: source, validWindow: source.validWindow, route: sharedRoute, noFullSync: source.noFullSync || self?.noFullSync });
        }
    }
    let rawDisk = !!self?.rawDisk;
    let structureKey = JSON.stringify({
        rawDisk,
        readerDiskLimit: self?.readerDiskLimit,
    });
    return { selfEntries, self, rawDisk, sourceSpecs, readerDiskLimit: self?.readerDiskLimit, structureKey };
}

function buildBucket(account: string, bucketName: string, routing: RemoteConfig, plan?: StorePlan): LoadedBucket {
    let folder = getBucketFolder(account, bucketName);
    if (!plan) {
        plan = computeStorePlan(account, bucketName, routing);
    }
    let { selfEntries, self } = plan;
    let store: IBucketStore;
    if (plan.rawDisk) {
        store = new ArchivesDisk(folder);
    } else {
        if (!self) {
            console.log(`This server is not in the routing config for bucket ${account}/${bucketName}: no longer synchronizing, valid window treated as [0, 0] (fast writes flush immediately), disk data kept and served`);
        }
        let sources: ArchivesSource[] = plan.sourceSpecs.map(spec => ({
            source: spec.sourceConfig && createApiArchives(spec.sourceConfig) || new ArchivesDisk(folder),
            validWindow: spec.validWindow,
            route: spec.route,
            noFullSync: spec.noFullSync,
            identity: sourceIdentity(spec.sourceConfig),
        }));
        store = new BlobStore(folder, sources, {
            onIndexChanged: key => {
                if (key !== ROUTING_FILE) return;
                void scheduleRoutingReload(account, bucketName);
            },
            readerDiskLimit: plan.readerDiskLimit,
            onWriteCounted: (kind, bytes) => countBucketWrite(`${account}/${bucketName}`, kind, bytes),
        });
    }
    let loaded: LoadedBucket = { account, bucketName, routing, routingJSON: JSON.stringify(routing), selfEntries, self, store, structureKey: plan.structureKey };
    scheduleWindowBoundaryRebuild(loaded);
    scheduleBoundaryScans(loaded);
    // A loaded bucket must actually be running: the store's init loads its index and starts its source synchronization, and it is lazy, so without this a bucket nothing has read from or written to sits inert - reporting no data and no syncing while its disk is full of files.
    if (store instanceof BlobStore) {
        void store.init().catch((e: Error) => console.error(`Initializing the store for bucket ${account}/${bucketName} failed: ${e.stack ?? e}`));
    }
    return loaded;
}

/** The routing file is ours, on our own disk, at a path we know - so it is read directly. Going through an ArchivesDisk would construct a whole store (handle cache sweep loop, uploads-folder cleanup) just to read one file. */
function getRoutingFilePath(folder: string): string {
    return path.join(folder, "files", ROUTING_FILE);
}
async function readRoutingFile(folder: string): Promise<Buffer | undefined> {
    try {
        return await fs.promises.readFile(getRoutingFilePath(folder));
    } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return undefined;
        throw e;
    }
}

async function readRoutingFromDisk(account: string, bucketName: string): Promise<RemoteConfig | undefined> {
    let data = await readRoutingFile(getBucketFolder(account, bucketName));
    if (!data) return undefined;
    return parseRoutingData(data);
}

async function loadBucket(account: string, bucketName: string): Promise<LoadedBucket | undefined> {
    let routing = await readRoutingFromDisk(account, bucketName);
    if (!routing) return undefined;
    return buildBucket(account, bucketName, routing);
}

export function getLoadedBucket(account: string, bucketName: string): Promise<LoadedBucket | undefined> {
    let key = `${account}/${bucketName}`;
    let loaded = buckets.get(key);
    if (!loaded) {
        loaded = loadBucket(account, bucketName);
        buckets.set(key, loaded);
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


const routingReloads = new Map<string, Promise<void>>();
function scheduleRoutingReload(account: string, bucketName: string, config?: { force?: boolean; reason?: string }): Promise<void> {
    let key = `${account}/${bucketName}`;
    let next = (routingReloads.get(key) || Promise.resolve())
        .then(() => checkRoutingChanged(account, bucketName, config))
        .catch(e => console.error(`Reloading routing config for bucket ${key} failed:`, e));
    routingReloads.set(key, next);
    return next;
}

async function checkRoutingChanged(account: string, bucketName: string, config?: { force?: boolean; reason?: string }): Promise<void> {
    let key = `${account}/${bucketName}`;
    let loaded = await buckets.get(key);
    if (!loaded) return;
    let routing = await readRoutingFromDisk(account, bucketName);
    if (!routing) return;
    if (!config?.force && JSON.stringify(routing) === loaded.routingJSON) return;
    let reason = config?.force && (config.reason || "forced") || "routing config changed";
    let plan = computeStorePlan(account, bucketName, routing);
    if (plan.structureKey === loaded.structureKey && loaded.store instanceof BlobStore) {
        console.log(`Applying the routing config to the running store for bucket ${key} (${reason})`);
        loaded.store.updateSources(plan.sourceSpecs.map(spec => {
            const sourceConfig = spec.sourceConfig;
            if (!sourceConfig) {
                return { identity: sourceIdentity(undefined), validWindow: spec.validWindow, create: (): IArchives => new ArchivesDisk(getBucketFolder(account, bucketName)) };
            }
            return {
                identity: sourceIdentity(sourceConfig),
                validWindow: spec.validWindow,
                route: spec.route,
                noFullSync: spec.noFullSync,
                create: () => createApiArchives(sourceConfig),
            };
        }));
        let updated: LoadedBucket = { ...loaded, routing, routingJSON: JSON.stringify(routing), selfEntries: plan.selfEntries, self: plan.self };
        buckets.set(key, Promise.resolve(updated));
        scheduleWindowBoundaryRebuild(updated);
        scheduleBoundaryScans(updated);
        broadcastRoutingChanged();
        return;
    }
    console.log(`Rebuilding the store for bucket ${key} (${reason})`);
    if (loaded.store instanceof BlobStore) {
        await loaded.store.dispose();
    }
    buckets.set(key, Promise.resolve(buildBucket(account, bucketName, routing, plan)));
    broadcastRoutingChanged();
}

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

const WRONG_TARGET_LOG_THROTTLE = 60 * 1000;
let lastWrongTargetLog = 0;
function logWrongTargetRejection(message: string): void {
    if (Date.now() - lastWrongTargetLog < WRONG_TARGET_LOG_THROTTLE) return;
    lastWrongTargetLog = Date.now();
    console.log(message);
}

const routingWrites = new Map<string, Promise<void>>();

async function writeRoutingConfig(account: string, bucketName: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
    let key = `${account}/${bucketName}`;
    let incoming = parseRoutingData(data);
    let loaded = await getLoadedBucket(account, bucketName);
    if (!loaded) {
        await new ArchivesDisk(getBucketFolder(account, bucketName)).set(ROUTING_FILE, data, { lastModified: config?.lastModified });
        buckets.set(key, Promise.resolve(buildBucket(account, bucketName, incoming)));
        broadcastRoutingChanged();
        console.log(`Created bucket ${key}`);
        return;
    }
    if (JSON.stringify(incoming) !== loaded.routingJSON && getConfigVersion(incoming) <= getConfigVersion(loaded.routing)) {
        let message = `Cannot update routing config for bucket ${key}: the new config differs from the current one but its version (${getConfigVersion(incoming)}) is not greater than the current version (${getConfigVersion(loaded.routing)}). Increment the version to update it. Current: ${loaded.routingJSON}. Attempted: ${JSON.stringify(incoming)}`;
        console.error(message);
        throw new Error(message);
    }
    let stored = incoming;
    let reinjected = 0;
    for (let intermediate of getIntermediateSources(expireIntermediateSources(loaded.routing, Date.now()))) {
        stored = injectIntermediateSource(stored, {
            splitUrl: findSplitUrl(loaded.routing, intermediate) || intermediate.url,
            intermediateUrl: intermediate.url,
            start: intermediate.validWindow[0],
            end: intermediate.validWindow[1],
        });
        reinjected++;
    }
    if (JSON.stringify(stored) !== JSON.stringify(incoming)) {
        console.log(`Re-injected ${reinjected} in-flight switchover windows into the incoming routing config for bucket ${key} (version ${getConfigVersion(incoming)})`);
    }
    await loaded.store.set(ROUTING_FILE, Buffer.from(serializeRemoteConfig(stored)), { lastModified: config?.lastModified });
    await scheduleRoutingReload(account, bucketName);
}

export async function writeBucketFile(account: string, bucketName: string, filePath: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
    assertWritesAllowed();
    if (filePath === ROUTING_FILE) {
        let key = `${account}/${bucketName}`;
        let run = (routingWrites.get(key) || Promise.resolve()).then(() => writeRoutingConfig(account, bucketName, data, config));
        routingWrites.set(key, run.then(() => { }, () => { }));
        return await run;
    }
    let loaded = await getLoadedBucket(account, bucketName);
    if (!loaded) {
        throw new Error(`Bucket ${account}/${bucketName} does not exist. Write its routing config to ${JSON.stringify(ROUTING_FILE)} to create it.`);
    }
    let writeTime = config?.lastModified || Date.now();
    let route = getRoute(filePath);
    if (!config?.lastModified && loaded.selfEntries.length) {
        let timeValid = loaded.selfEntries.filter(x => writeTime >= x.validWindow[0] && writeTime < x.validWindow[1]);
        if (!timeValid.length) {
            logWrongTargetRejection(`Rejecting fresh write of ${JSON.stringify(filePath)} to bucket ${account}/${bucketName}: writeTime ${writeTime} (${new Date(writeTime).toISOString()}) is outside all our valid windows ${JSON.stringify(loaded.selfEntries.map(x => x.validWindow))} (a switchover moved the write target)`);
            throw new Error(`${STORAGE_WRONG_VALID_WINDOW} This server is not a valid write target at ${writeTime} for bucket ${account}/${bucketName} (our valid windows: ${JSON.stringify(loaded.selfEntries.map(x => x.validWindow))}). Re-resolve the currently valid source and retry.`);
        }
        if (!timeValid.some(x => routeContains(x.route, route))) {
            logWrongTargetRejection(`Rejecting fresh write of ${JSON.stringify(filePath)} to bucket ${account}/${bucketName}: route ${route} is outside our routes ${JSON.stringify(timeValid.map(x => x.route || FULL_ROUTE))} at writeTime ${writeTime} (the client's shard config is stale)`);
            throw new Error(`${STORAGE_WRONG_ROUTE} This server does not handle route ${route} (key ${JSON.stringify(filePath)}) for bucket ${account}/${bucketName} (our routes at this time: ${JSON.stringify(timeValid.map(x => x.route || FULL_ROUTE))}). Re-resolve the source for this key and retry.`);
        }
    }
    await assertMutable(loaded, filePath, writeTime);
    await loaded.store.set(filePath, data, { ...getWriteConfig(loaded, writeTime, route), lastModified: writeTime });
}

export function getBucketConfig(bucket: LoadedBucket): ArchivesConfig {
    let progress = bucket.store.getSyncProgress?.();
    return {
        supportsChangesAfter: !!bucket.store.getChangesAfter,
        remoteConfig: bucket.routing,
        index: progress?.index,
        indexSources: progress?.sources,
        readerDiskLimit: progress?.readerDiskLimit,
        syncing: progress?.syncing,
    };
}

export async function rebuildAllLoadedBuckets(): Promise<void> {
    for (let key of [...buckets.keys()]) {
        let slash = key.indexOf("/");
        await scheduleRoutingReload(key.slice(0, slash), key.slice(slash + 1), { force: true, reason: "all loaded buckets were asked to rebuild" });
    }
}

const OWN_CONFIG_WRITE_THROTTLE = 30 * 1000;
const INTERMEDIATE_MAINTAIN_INTERVAL = 60 * 1000;
let lastOwnConfigWrite = 0;

async function writeOwnRoutingConfig(loaded: LoadedBucket, updated: RemoteConfig, reason: string): Promise<void> {
    let key = `${loaded.account}/${loaded.bucketName}`;
    let sinceLast = Date.now() - lastOwnConfigWrite;
    if (sinceLast < OWN_CONFIG_WRITE_THROTTLE) {
        console.log(`Not writing our own routing config update for bucket ${key} (${reason}): the last one was ${sinceLast}ms ago, under the ${OWN_CONFIG_WRITE_THROTTLE}ms throttle. Retrying on the next maintenance pass. Wanted: ${JSON.stringify(updated)}`);
        return;
    }
    lastOwnConfigWrite = Date.now();
    let version = nextIntermediateVersion(getConfigVersion(loaded.routing));
    let next: RemoteConfig = { ...updated, version };
    console.log(`Writing our own routing config update for bucket ${key} (${reason}), version ${getConfigVersion(loaded.routing)} -> ${version}: ${JSON.stringify(next)}`);
    let data = Buffer.from(serializeRemoteConfig(next));
    await writeBucketFile(loaded.account, loaded.bucketName, ROUTING_FILE, data);
    await propagateRoutingConfig(loaded, next, data);
}

async function propagateRoutingConfig(loaded: LoadedBucket, next: RemoteConfig, data: Buffer): Promise<void> {
    let targets = new Map<string, HostedConfig | BackblazeConfig>();
    for (let source of [...loaded.routing.sources, ...next.sources]) {
        if (typeof source === "string" || source.intermediate) continue;
        if (source.type === "remote") {
            let parsed = parseHostedUrl(source.url);
            if (parsed.account !== loaded.account || parsed.bucketName !== loaded.bucketName) continue;
        }
        if (targets.has(source.url)) continue;
        targets.set(source.url, source);
    }
    for (let [url, source] of targets) {
        try {
            await createApiArchives(source).set(ROUTING_FILE, data);
            console.log(`Propagated our routing config update to ${url}`);
        } catch (e) {
            console.error(`Propagating our routing config update to ${url} failed: ${(e as Error).stack ?? e}`);
        }
    }
}

async function maintainIntermediates(): Promise<void> {
    let { domain, port } = getStorageServerConfig();
    let takeover = getTakeoverIntermediate();
    for (let key of [...buckets.keys()]) {
        let loadedPromise = buckets.get(key);
        if (!loadedPromise) continue;
        let loaded = await loadedPromise.catch(() => undefined);
        if (!loaded) continue;
        let expired = expireIntermediateSources(loaded.routing, Date.now());
        if (JSON.stringify(expired) !== JSON.stringify(loaded.routing)) {
            await writeOwnRoutingConfig(loaded, expired, `switchover windows expired more than ${INTERMEDIATE_EXPIRE_GRACE / 1000}s ago`);
            continue;
        }
        if (!takeover) continue;
        let mainUrl = loaded.routing.sources.find(x => {
            if (typeof x === "string" || x.type !== "remote" || x.intermediate) return false;
            let parsed = parseHostedUrl(x.url);
            return parsed.address === domain && parsed.port === port;
        }) as HostedConfig | undefined;
        if (!mainUrl) continue;
        let injected = injectIntermediateSource(loaded.routing, {
            splitUrl: mainUrl.url,
            intermediateUrl: replaceHostedUrlPort(mainUrl.url, takeover.altPort),
            start: takeover.start,
            end: takeover.end,
        });
        if (JSON.stringify(injected) === JSON.stringify(loaded.routing)) continue;
        await writeOwnRoutingConfig(loaded, injected, `we are a deploy successor: writes route to our alternate port ${takeover.altPort} from ${new Date(takeover.start).toISOString()} until our predecessor is killed at ${new Date(takeover.end).toISOString()}`);
    }
}

/** Started by deployTakeover once we are actually a deploy successor listening on an alternate port. Until then there are no switchover windows to write or expire, so nothing polls. */
export const startIntermediateMaintenance = lazy(() => {
    void maintainIntermediates().catch((e: Error) => console.error(`Maintaining switchover routing windows failed: ${e.stack ?? e}`));
    runInfinitePoll(INTERMEDIATE_MAINTAIN_INTERVAL, maintainIntermediates);
});

export type BucketDiskInfo = {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
};
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

async function getDiskInfo(folder: string): Promise<BucketDiskInfo> {
    let stats = await fs.promises.statfs(folder);
    let blockSize = Number(stats.bsize);
    let totalBytes = Number(stats.blocks) * blockSize;
    return {
        totalBytes,
        // Matches the server's own low-space check: what an unprivileged process can actually use
        freeBytes: Number(stats.bavail) * blockSize,
        usedBytes: totalBytes - Number(stats.bfree) * blockSize,
    };
}

export type ActiveBucketInfo = {
    folder: string;
    /** The routing config the bucket is RUNNING on, straight from memory - including switchover windows written since it loaded */
    routing: RemoteConfig;
    /** Our own entries in that config, and the one currently valid */
    selfEntries: HostedConfig[];
    self?: HostedConfig;
    config: ArchivesConfig;
};

/** The live in-memory state of ONE bucket, answered without touching the disk (no routing file read, no statfs, no stored write stats). Returns an error string when the bucket is not loaded here, which is the normal state for a bucket nothing has accessed since startup. */
export async function getActiveBucket(account: string, bucketName: string): Promise<ActiveBucketInfo | string> {
    let key = `${account}/${bucketName}`;
    let loadedPromise = buckets.get(key);
    if (!loadedPromise) {
        return `Bucket ${key} is not loaded on this server, so it has no live state (it loads on first access)`;
    }
    let loaded: LoadedBucket | undefined;
    try {
        loaded = await loadedPromise;
    } catch (e) {
        return `Bucket ${key} failed to load on this server: ${String((e as Error).stack ?? e).slice(0, 500)}`;
    }
    if (!loaded) {
        return `Bucket ${key} does not exist on this server`;
    }
    return toActiveBucketInfo(loaded);
}

function toActiveBucketInfo(loaded: LoadedBucket): ActiveBucketInfo {
    return {
        folder: getBucketFolder(loaded.account, loaded.bucketName),
        routing: loaded.routing,
        selfEntries: loaded.selfEntries,
        self: loaded.self,
        config: getBucketConfig(loaded),
    };
}

/** Loads a bucket that exists on this server's disk into memory, which starts its synchronization and window timers, and returns its live state. Nothing is written and no other server is contacted - unlike building an ArchivesChain for it, which would probe every source and could write the routing config. Already-loaded buckets just return their state. */
export async function activateBucket(account: string, bucketName: string): Promise<ActiveBucketInfo | string> {
    let key = `${account}/${bucketName}`;
    let wasLoaded = buckets.has(key);
    let loaded: LoadedBucket | undefined;
    try {
        loaded = await getLoadedBucket(account, bucketName);
    } catch (e) {
        return `Bucket ${key} failed to load on this server: ${String((e as Error).stack ?? e).slice(0, 500)}`;
    }
    if (!loaded) {
        return `Bucket ${key} does not exist on this server (no routing file in ${getBucketFolder(account, bucketName)})`;
    }
    // Wait for the index to load, so the totals we return are the real ones rather than zeroes from a store that has not read its index yet. The source scans keep running in the background.
    if (loaded.store instanceof BlobStore) {
        await loaded.store.init();
    }
    if (!wasLoaded) {
        console.log(`Activated bucket ${key} on request: it is now loaded and synchronizing`);
    }
    return toActiveBucketInfo(loaded);
}

export async function listAccountBuckets(account: string): Promise<ServerBucketInfo[]> {
    let start = Date.now();
    let timings = new Map<string, number>();
    async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
        let began = Date.now();
        try {
            return await run();
        } finally {
            timings.set(name, (timings.get(name) || 0) + (Date.now() - began));
        }
    }
    let accountFolder = path.join(getStorageServerConfig().folder, "buckets2", account);
    let names: string[];
    try {
        names = await timed("readdir", () => fs.promises.readdir(accountFolder));
    } catch {
        return [];
    }
    try {
        return await Promise.all(names.map(async bucketName => {
            let key = `${account}/${bucketName}`;
            let folder = getBucketFolder(account, bucketName);
            let base: ServerBucketInfo = { bucketName, active: false, folder };
            let [disk, writeStats] = await Promise.all([
                timed("statfs", () => getDiskInfo(folder)).catch((e: Error) => {
                    base.diskError = String(e.stack ?? e).slice(0, 500);
                    return undefined;
                }),
                timed("writeStats", () => getBucketWriteStats(key)),
            ]);
            base.disk = disk;
            base.writeStats = writeStats;
            const loadedPromise = buckets.get(key);
            if (loadedPromise) {
                try {
                    let loaded = await timed("awaitLoaded", () => loadedPromise);
                    if (loaded) {
                        return { ...base, active: true, config: getBucketConfig(loaded) };
                    }
                } catch (e) {
                    return { ...base, active: true, error: String((e as Error).stack ?? e).slice(0, 500) };
                }
            }
            try {
                const data = await timed("readRoutingFile", () => readRoutingFile(folder));
                if (!data) {
                    return { ...base, error: `No routing file (${ROUTING_FILE})` };
                }
                let parsed = await timed("parseRouting", async () => parseRoutingData(data));
                return { ...base, config: { remoteConfig: parsed } };
            } catch (e) {
                return { ...base, error: String((e as Error).stack ?? e).slice(0, 500) };
            }
        }));
    } finally {
        // The parts run concurrently, so these are summed wall times per part, not a breakdown of the total
        let parts = [...timings].map(([name, ms]) => `${name} ${ms}ms`).join(", ");
        console.log(`listAccountBuckets(${account}) took ${Date.now() - start}ms for ${names.length} buckets: ${parts}`);
    }
}

export async function deleteBucketFile(account: string, bucketName: string, filePath: string): Promise<void> {
    if (filePath === ROUTING_FILE) {
        throw new Error(`The routing config ${JSON.stringify(ROUTING_FILE)} cannot be deleted (overwrite it to change the bucket's configuration)`);
    }
    let loaded = await getLoadedBucket(account, bucketName);
    if (!loaded) return;
    await loaded.store.del(filePath, getWriteConfig(loaded, Date.now(), getRoute(filePath)));
}

const LARGE_FILE_PART_SIZE = 8 * 1024 * 1024;

class ArchivesLocalBucket implements IArchives {
    constructor(private account: string, private bucketName: string) { }

    private async getBucket(): Promise<LoadedBucket | undefined> {
        return await getLoadedBucket(this.account, this.bucketName);
    }

    public getDebugName() {
        return `localBucket account ${this.account} bucket ${this.bucketName}`;
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
    public async set(fileName: string, data: Buffer, config?: { lastModified?: number }): Promise<string> {
        await writeBucketFile(this.account, this.bucketName, fileName, data, config);
        return fileName;
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
        if (!bucket) return { supportsChangesAfter: true };
        return getBucketConfig(bucket);
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
