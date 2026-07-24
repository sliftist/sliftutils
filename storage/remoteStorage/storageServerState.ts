import path from "path";
import fs from "fs";
import { lazy } from "socket-function/src/caching";
import { sort } from "socket-function/src/misc";
import { runInfinitePoll } from "socket-function/src/batching";
import { ArchivesDisk } from "../ArchivesDisk";
import { BlobStore, RawDiskStore, IBucketStore, DEFAULT_FAST_WRITE_DELAY, WINDOW_END_FLUSH_MARGIN } from "./blobStore";
import {
    RemoteConfig, HostedConfig, SourceConfig, IArchives, ArchivesSource, ArchivesConfig, ArchivesSyncStatus,
    ArchiveFileInfo, ChangesAfterConfig, DelConfig, FindConfig, GetConfig, GetInfoConfig, SetConfig, SyncActivity, FULL_ROUTE,
} from "../IArchives";
import { ROUTING_FILE, parseRoutingData, serializeRemoteConfig, parseHostedUrl, replaceHostedUrlPort, buildFileUrl, getConfigVersion, routeIntersection, normalizeSource } from "./remoteConfig";
import { injectIntermediateSource, expireIntermediateSources, getIntermediateSources, findSplitUrl, nextIntermediateVersion, INTERMEDIATE_EXPIRE_GRACE } from "./intermediateSources";
import { getTakeoverIntermediate } from "./deployTakeover";
import { createApiArchives, listServerActiveBucketKeys } from "./createArchives";
import { broadcastRoutingChanged } from "./storageController";
import { getStorageServerConfig, assertWritesAllowed } from "./serverConfig";
import { getBucketFolder, readRoutingFile, readRoutingFromDisk, getRoutingFileResult, getDiskInfo, BucketDiskInfo } from "./bucketDisk";
import { computeStorePlan, findSelfIndexes, StorePlan, StorePlanStore, SelfSummary } from "./storePlan";

// The storage server's bucket lifecycle: the map of loaded buckets (each = its routing config + one BlobStore per route), keeping them current (routing reloads, window-boundary rebuilds, boundary scans), writing/propagating routing configs, deploy-switchover maintenance, and the server-level bucket listings. Store selection (sourceConfig -> store) lives here too, as findBucketStore.

export type LoadedStore = {
    // JSON of the route (FULL_ROUTE when absent) - the ONE route this store serves
    routeKey: string;
    route?: [number, number];
    // The exact self entries this store serves (same route, different valid windows). Empty when we are not in the config but still serve our disk data.
    entries: HostedConfig[];
    folder: string;
    store: IBucketStore;
};

// A bucket loaded on this server: its routing config and its per-route stores. Pure data - the stores themselves do the work.
export type BucketState = {
    account: string;
    bucketName: string;
    routing: RemoteConfig;
    routingJSON: string;
    selfEntries: HostedConfig[];
    self: SelfSummary | undefined;
    stores: LoadedStore[];
    structureKey: string;
};

/** JSON with sorted object keys and undefined-valued keys dropped, so two configs that mean the same thing compare equal regardless of key order or which side serialized them. */
function stableStringify(value: unknown): string {
    if (!value || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(x => stableStringify(x)).join(",")}]`;
    }
    let entries = Object.entries(value as Record<string, unknown>).filter(x => x[1] !== undefined);
    sort(entries, x => x[0]);
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
}

/** The loaded bucket, loading it (which instantiates its stores and starts their synchronization) if needed. A bucket that does not exist on this server throws - callers never see undefined buckets. */
export async function requireBucket(account: string, bucketName: string): Promise<BucketState> {
    let bucket = await getLoadedBucket(account, bucketName);
    if (!bucket) {
        throw new Error(`Bucket ${account}/${bucketName} does not exist on this server. Write its routing config to ${JSON.stringify(ROUTING_FILE)} to create it.`);
    }
    return bucket;
}

/** The store serving a request: the exact config entry the CLIENT selected, matched by equality (key order ignored) against the bucket's own entries. A match is honored even when its window has passed - the selection never validates, the store's own validation throws instead. Throws when nothing matches, listing what is available. */
export async function findBucketStore(account: string, bucketName: string, sourceConfig: SourceConfig | undefined): Promise<LoadedStore> {
    let bucket = await requireBucket(account, bucketName);
    if (!sourceConfig) {
        throw new Error(`No remote source configuration was provided for bucket ${account}/${bucketName}: every request must say which configured source it selected. Available: ${JSON.stringify(bucket.selfEntries)}`);
    }
    let wanted = stableStringify(sourceConfig);
    for (let s of bucket.stores) {
        if (s.entries.some(e => stableStringify(e) === wanted)) return s;
    }
    throw new Error(`No source on this server matches the requested remote configuration for bucket ${account}/${bucketName}. Requested: ${JSON.stringify(sourceConfig)}. Available: ${JSON.stringify(bucket.selfEntries)}`);
}

/** Internal (store-to-store) reads skip store selection entirely: the caller is another store whose index says this MACHINE holds the bytes - the persisted holder identity is just a URL, which cannot name a store. Whichever store's folder has the newest copy answers. */
export async function readBucketInternal(account: string, bucketName: string, config: { path: string; range?: { start: number; end: number }; includeTombstones?: boolean }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
    let bucket = await requireBucket(account, bucketName);
    let results = await Promise.all(bucket.stores.map(s => s.store.get2({ path: config.path, range: config.range, includeTombstones: config.includeTombstones, internal: true })));
    let best: { data: Buffer; writeTime: number; size: number } | undefined;
    for (let result of results) {
        if (result && (!best || result.writeTime > best.writeTime)) {
            best = result;
        }
    }
    return best;
}

export function getBucketConfig(bucket: BucketState): ArchivesConfig {
    let index = { fileCount: 0, byteCount: 0 };
    let indexSources: { debugName: string; fileCount: number; byteCount: number }[] = [];
    let syncing: SyncActivity[] = [];
    let readerDiskLimit: number | undefined;
    for (let s of bucket.stores) {
        let progress = s.store.getSyncProgress?.();
        if (!progress) continue;
        index.fileCount += progress.index.fileCount;
        index.byteCount += progress.index.byteCount;
        indexSources.push(...progress.sources);
        syncing.push(...progress.syncing);
        readerDiskLimit = readerDiskLimit || progress.readerDiskLimit;
    }
    return {
        // Native change-feed support = the stores keep an index (rawDisk buckets emulate getChangesAfter2 with a full listing) - clients use this to pick their scan cadence
        supportsChangesAfter: bucket.stores.some(s => s.store instanceof BlobStore),
        remoteConfig: bucket.routing,
        index,
        indexSources,
        readerDiskLimit,
        syncing,
    };
}

export async function bucketSyncStatus(bucket: BucketState): Promise<ArchivesSyncStatus> {
    let supported = bucket.stores.filter(s => s.store.getSyncStatus);
    if (!supported.length) {
        throw new Error(`Bucket ${bucket.account}/${bucket.bucketName} does not support getSyncStatus (rawDisk buckets have no synchronization)`);
    }
    let statuses = await Promise.all(supported.map(async s => {
        let getSyncStatus = s.store.getSyncStatus;
        if (!getSyncStatus) {
            throw new Error(`getSyncStatus disappeared from a store for ${bucket.account}/${bucket.bucketName}`);
        }
        return await getSyncStatus.call(s.store);
    }));
    return {
        allScansComplete: statuses.every(x => x.allScansComplete),
        indexSize: statuses.reduce((sum, x) => sum + x.indexSize, 0),
        sources: statuses.flatMap(x => x.sources),
    };
}

export async function bucketIndexTotals(bucket: BucketState): Promise<{ fileCount: number; byteCount: number; sources: { debugName: string; fileCount: number; byteCount: number }[] } | undefined> {
    let supported = bucket.stores.filter(s => s.store.computeIndexTotals);
    if (!supported.length) return undefined;
    let totals = await Promise.all(supported.map(async s => {
        let computeIndexTotals = s.store.computeIndexTotals;
        if (!computeIndexTotals) {
            throw new Error(`computeIndexTotals disappeared from a store for ${bucket.account}/${bucket.bucketName}`);
        }
        return await computeIndexTotals.call(s.store);
    }));
    return {
        fileCount: totals.reduce((sum, x) => sum + x.fileCount, 0),
        byteCount: totals.reduce((sum, x) => sum + x.byteCount, 0),
        sources: totals.flatMap(x => x.sources),
    };
}

const buckets = new Map<string, Promise<BucketState | undefined>>();

const MAX_REBUILD_TIMER_DELAY = 2 ** 31 - 1;
const REBUILD_BOUNDARY_BUFFER = 1000;

function scheduleWindowBoundaryRebuild(loaded: BucketState): void {
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

function scheduleBoundaryScans(loaded: BucketState): void {
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
        let effective = loaded.routing;
        let selfIndexes = findSelfIndexes(effective, loaded.account, loaded.bucketName);
        let selfIndexSet = new Set(selfIndexes);
        let selves = selfIndexes.map(i => effective.sources[i] as HostedConfig).filter(x => x.validWindow[0] === windowStart);
        if (!selves.length) return;
        let prevTime = windowStart - 1;
        // Everything is per-store: each self entry's route has its own store, and that store's disk/remote boundary pulls only concern its own route slice
        let needDiskScan = new Set<LoadedStore>();
        let remoteOwners = new Map<LoadedStore, Map<number, [number, number]>>();
        for (let self of selves) {
            let selfRoute = self.route || FULL_ROUTE;
            let selfStore = loaded.stores.find(x => x.routeKey === JSON.stringify(selfRoute));
            if (!selfStore || !(selfStore.store instanceof BlobStore)) continue;
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
                    needDiskScan.add(selfStore);
                } else {
                    let owners = remoteOwners.get(selfStore);
                    if (!owners) {
                        owners = new Map();
                        remoteOwners.set(selfStore, owners);
                    }
                    let existing = owners.get(j);
                    owners.set(j, existing && [Math.min(existing[0], claimed[0]), Math.max(existing[1], claimed[1])] as [number, number] || claimed);
                }
            }
        }
        if (!needDiskScan.size && !remoteOwners.size) return;
        console.log(`Boundary scan (${label}): diskScans=${needDiskScan.size}, stores with remote previous-window owners: ${remoteOwners.size}`);
        for (let selfStore of needDiskScan) {
            if (selfStore.store instanceof BlobStore) {
                await selfStore.store.rescanBase();
            }
        }
        let since = windowStart - BOUNDARY_SCAN_LOOKBACK;
        for (let [selfStore, owners] of remoteOwners) {
            if (!(selfStore.store instanceof BlobStore)) continue;
            for (let [sourceIndex, route] of owners) {
                let ownerSource = effective.sources[sourceIndex];
                if (typeof ownerSource === "string") continue;
                try {
                    await selfStore.store.boundaryScanRemote(createApiArchives(ownerSource), { since, route });
                } catch (e) {
                    console.error(`Boundary scan (${label}) of previous-window owner (source index ${sourceIndex}) failed: ${(e as Error).stack ?? e}`);
                }
            }
        }
    } finally {
        boundaryScansRunning.delete(bucketKey);
    }
}

const resolvedSourceArchives = new Map<string, IArchives>();
/** A cached IArchives for a persisted source identity: a routing URL (hosted/backblaze) or a disk folder path - the form BlobStore's sources list stores. Configuration (valid windows, routes) decides WHEN a source should be used; for reading bytes the index says a source holds, the URL alone is enough - even for sources no longer in any config. */
export function resolveSourceArchives(url: string): IArchives {
    let existing = resolvedSourceArchives.get(url);
    if (existing) return existing;
    let archives: IArchives;
    if (url.startsWith("https://")) {
        // The config is fabricated from the bare URL and can never exact-match a server's entries - which is fine, because holder reads are internal reads, and internal reads never select a store (see readBucketInternal)
        archives = createApiArchives(normalizeSource(url));
    } else {
        archives = new ArchivesDisk(url);
    }
    resolvedSourceArchives.set(url, archives);
    return archives;
}

function sourceIdentity(sourceConfig: SourceConfig | undefined): string {
    if (!sourceConfig) return "disk";
    return JSON.stringify({ ...sourceConfig, validWindow: undefined, route: undefined });
}

function buildStore(account: string, bucketName: string, planStore: StorePlanStore): IBucketStore {
    let folder = getBucketFolder(account, bucketName, planStore.route);
    if (planStore.rawDisk) {
        return new RawDiskStore(new ArchivesDisk(folder));
    }
    let sources: ArchivesSource[] = planStore.sourceSpecs.map(spec => ({
        source: spec.sourceConfig && createApiArchives(spec.sourceConfig) || new ArchivesDisk(folder),
        url: spec.sourceConfig?.url || folder,
        validWindow: spec.validWindow,
        route: spec.route,
        noFullSync: spec.noFullSync,
        intermediate: spec.sourceConfig?.intermediate,
        identity: sourceIdentity(spec.sourceConfig),
    }));
    return new BlobStore(folder, sources, {
        readerDiskLimit: planStore.readerDiskLimit,
        onWriteCounted: (kind, bytes) => countBucketWrite(`${account}/${bucketName}`, kind, bytes),
        resolveSourceUrl: resolveSourceArchives,
        entries: planStore.entries,
    });
}

function buildBucket(account: string, bucketName: string, routing: RemoteConfig, plan?: StorePlan): BucketState {
    if (!plan) {
        plan = computeStorePlan(account, bucketName, routing);
    }
    let { selfEntries, self } = plan;
    if (!self) {
        console.log(`This server is not in the routing config for bucket ${account}/${bucketName}: no longer synchronizing, valid window treated as [0, 0] (fast writes flush immediately), disk data kept and served`);
    }
    let stores: LoadedStore[] = plan.stores.map(planStore => ({
        routeKey: planStore.routeKey,
        route: planStore.route,
        entries: planStore.entries,
        folder: getBucketFolder(account, bucketName, planStore.route),
        store: buildStore(account, bucketName, planStore),
    }));
    let loaded: BucketState = { account, bucketName, routing, routingJSON: JSON.stringify(routing), selfEntries, self, stores, structureKey: plan.structureKey };
    scheduleWindowBoundaryRebuild(loaded);
    scheduleBoundaryScans(loaded);
    // A loaded bucket must actually be running: each store's init loads its index and starts its source synchronization, and it is lazy, so without this a bucket nothing has read from or written to sits inert - reporting no data and no syncing while its disk is full of files.
    for (let s of stores) {
        if (s.store instanceof BlobStore) {
            let store = s.store;
            void store.init().catch((e: Error) => console.error(`Initializing the store for bucket ${account}/${bucketName} (route ${s.routeKey}) failed: ${e.stack ?? e}`));
        }
    }
    return loaded;
}

async function loadBucket(account: string, bucketName: string): Promise<BucketState | undefined> {
    let routing = await readRoutingFromDisk(account, bucketName);
    if (!routing) return undefined;
    return buildBucket(account, bucketName, routing);
}

export function getLoadedBucket(account: string, bucketName: string): Promise<BucketState | undefined> {
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
    if (plan.structureKey === loaded.structureKey) {
        console.log(`Applying the routing config to the running stores for bucket ${key} (${reason})`);
        for (let planStore of plan.stores) {
            let live = loaded.stores.find(x => x.routeKey === planStore.routeKey);
            // structureKey equality means the store set (routes, rawDisk, limits) is unchanged, so every plan store has its live twin
            if (!live || !(live.store instanceof BlobStore)) continue;
            let storeFolder = live.folder;
            live.store.updateSources(planStore.sourceSpecs.map(spec => {
                const sourceConfig = spec.sourceConfig;
                if (!sourceConfig) {
                    return { identity: sourceIdentity(undefined), url: storeFolder, validWindow: spec.validWindow, create: (): IArchives => new ArchivesDisk(storeFolder) };
                }
                return {
                    identity: sourceIdentity(sourceConfig),
                    url: sourceConfig.url,
                    validWindow: spec.validWindow,
                    route: spec.route,
                    noFullSync: spec.noFullSync,
                    intermediate: sourceConfig.intermediate,
                    create: () => createApiArchives(sourceConfig),
                };
            }), planStore.entries);
            live.entries = planStore.entries;
        }
        loaded.routing = routing;
        loaded.routingJSON = JSON.stringify(routing);
        loaded.selfEntries = plan.selfEntries;
        loaded.self = plan.self;
        scheduleWindowBoundaryRebuild(loaded);
        scheduleBoundaryScans(loaded);
        broadcastRoutingChanged();
        return;
    }
    console.log(`Rebuilding the stores for bucket ${key} (${reason}): structure changed from ${loaded.structureKey} to ${plan.structureKey}`);
    for (let s of loaded.stores) {
        if (s.store instanceof BlobStore) {
            await s.store.dispose();
        }
    }
    buckets.set(key, Promise.resolve(buildBucket(account, bucketName, routing, plan)));
    broadcastRoutingChanged();
}

const routingWrites = new Map<string, Promise<void>>();

/** The routing-config write path - the ONE write that cannot go through a store (it is what CREATES the bucket and its stores). Serialized per bucket: concurrent config writes would race the version check. */
export async function queueRoutingConfigWrite(account: string, bucketName: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
    assertWritesAllowed();
    let key = `${account}/${bucketName}`;
    let run = (routingWrites.get(key) || Promise.resolve()).then(() => writeRoutingConfig(account, bucketName, data, config));
    routingWrites.set(key, run.then(() => { }, () => { }));
    return await run;
}

async function writeRoutingConfig(account: string, bucketName: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
    let key = `${account}/${bucketName}`;
    let incoming = parseRoutingData(data);
    let loaded = await getLoadedBucket(account, bucketName);
    if (!loaded) {
        await resolveSourceArchives(getBucketFolder(account, bucketName)).set(ROUTING_FILE, data, { lastModified: config?.lastModified });
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
    // Written straight into the plain bucket folder: the routing file defines the per-route stores, so it never flows through them
    await resolveSourceArchives(getBucketFolder(account, bucketName)).set(ROUTING_FILE, Buffer.from(serializeRemoteConfig(stored)), { lastModified: config?.lastModified });
    await scheduleRoutingReload(account, bucketName);
}

/** Which buckets this process currently has loaded - what a deploy successor asks its predecessor for, so it activates exactly the buckets that are actually in use. */
export function getActiveBucketKeys(): { account: string; bucketName: string }[] {
    return [...buckets.keys()].map(key => {
        let slash = key.indexOf("/");
        return { account: key.slice(0, slash), bucketName: key.slice(slash + 1) };
    });
}

export async function rebuildAllLoadedBuckets(): Promise<void> {
    for (let key of [...buckets.keys()]) {
        let slash = key.indexOf("/");
        await scheduleRoutingReload(key.slice(0, slash), key.slice(slash + 1), { force: true, reason: "all loaded buckets were asked to rebuild" });
    }
}

const OWN_CONFIG_WRITE_THROTTLE = 30 * 1000;
const INTERMEDIATE_MAINTAIN_INTERVAL = 60 * 1000;
// Per bucket, not global: a switchover has to write every bucket's windows at once, and a shared throttle would let only one bucket through per interval
const lastOwnConfigWrite = new Map<string, number>();

async function writeOwnRoutingConfig(loaded: BucketState, updated: RemoteConfig, reason: string): Promise<void> {
    let key = `${loaded.account}/${loaded.bucketName}`;
    let sinceLast = Date.now() - (lastOwnConfigWrite.get(key) || 0);
    if (sinceLast < OWN_CONFIG_WRITE_THROTTLE) {
        console.log(`Not writing our own routing config update for bucket ${key} (${reason}): the last one was ${sinceLast}ms ago, under the ${OWN_CONFIG_WRITE_THROTTLE}ms throttle. Retrying on the next maintenance pass. Wanted: ${JSON.stringify(updated)}`);
        return;
    }
    lastOwnConfigWrite.set(key, Date.now());
    let version = nextIntermediateVersion(getConfigVersion(loaded.routing));
    let next: RemoteConfig = { ...updated, version };
    console.log(`Writing ${ROUTING_FILE} for bucket ${key} (${reason}), version ${getConfigVersion(loaded.routing)} -> ${version}: ${JSON.stringify(next)}`);
    let data = Buffer.from(serializeRemoteConfig(next));
    await queueRoutingConfigWrite(loaded.account, loaded.bucketName, data);
    await propagateRoutingConfig(loaded, next, data);
}

async function propagateRoutingConfig(loaded: BucketState, next: RemoteConfig, data: Buffer): Promise<void> {
    let targets = new Map<string, SourceConfig>();
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
            console.log(`Wrote ${ROUTING_FILE} for bucket ${loaded.account}/${loaded.bucketName} to ${url}`);
        } catch (e) {
            console.error(`Propagating our routing config update to ${url} failed: ${(e as Error).stack ?? e}`);
        }
    }
}

async function maintainIntermediates(): Promise<void> {
    let { domain, port } = getStorageServerConfig();
    let takeover = getTakeoverIntermediate();
    let written: string[] = [];
    let alreadyCorrect: string[] = [];
    let notOurs: string[] = [];
    // ONLY buckets already in memory. A switchover must never load a bucket: loading starts its synchronization, and buckets nothing has touched (legacy ones especially) have no writes to hand off in the first place. One that does get used mid-switchover loads on that access, and the next pass gives it its window.
    let keys = [...buckets.keys()];
    for (let key of keys) {
        let loadedPromise = buckets.get(key);
        if (!loadedPromise) continue;
        let loaded = await loadedPromise.catch(() => undefined);
        if (!loaded) continue;
        let expired = expireIntermediateSources(loaded.routing, Date.now());
        if (JSON.stringify(expired) !== JSON.stringify(loaded.routing)) {
            await writeOwnRoutingConfig(loaded, expired, `switchover windows expired more than ${INTERMEDIATE_EXPIRE_GRACE / 1000}s ago`);
            written.push(key);
            continue;
        }
        if (!takeover) continue;
        let mainUrl = loaded.routing.sources.find(x => {
            if (typeof x === "string" || x.type !== "remote" || x.intermediate) return false;
            let parsed = parseHostedUrl(x.url);
            return parsed.address === domain && parsed.port === port;
        }) as HostedConfig | undefined;
        if (!mainUrl) {
            notOurs.push(key);
            continue;
        }
        let injected = injectIntermediateSource(loaded.routing, {
            splitUrl: mainUrl.url,
            intermediateUrl: replaceHostedUrlPort(mainUrl.url, takeover.altPort),
            start: takeover.start,
            end: takeover.end,
        });
        if (JSON.stringify(injected) === JSON.stringify(loaded.routing)) {
            alreadyCorrect.push(key);
            continue;
        }
        await writeOwnRoutingConfig(loaded, injected, `we are a deploy successor: writes route to our alternate port ${takeover.altPort} from ${new Date(takeover.start).toISOString()} until our predecessor is killed at ${new Date(takeover.end).toISOString()}`);
        written.push(key);
    }
    if (!takeover) return;
    if (!keys.length) {
        console.log(`No active buckets, so no config files to write the intermediate into (a bucket is only active once something uses it)`);
        return;
    }
    if (!written.length) {
        console.log(`Wrote no config files: of ${keys.length} active buckets, ${alreadyCorrect.length} already contain the intermediate and ${notOurs.length} are not hosted by us`);
    }
}

/** Our predecessor still holds the main port and has been serving all along, so it - not us - knows which buckets are in use. We activate exactly those, which is what makes their config files get the intermediate; nothing else on disk is touched. */
async function activatePredecessorBuckets(): Promise<void> {
    let { domain, port } = getStorageServerConfig();
    let url = `https://${domain}:${port}`;
    let keys: { account: string; bucketName: string }[];
    try {
        keys = await listServerActiveBucketKeys({ url });
    } catch (e) {
        console.error(`Could not ask our predecessor on ${url} which buckets are active, so only buckets used on this process get the intermediate: ${(e as Error).stack ?? e}`);
        return;
    }
    if (!keys.length) {
        console.log(`Our predecessor on ${url} has no active buckets, so there are no config files to write the intermediate into`);
        return;
    }
    console.log(`Our predecessor on ${url} has ${keys.length} active buckets, activating them here so their config files get the intermediate: ${keys.map(x => `${x.account}/${x.bucketName}`).join(", ")}`);
    for (let { account, bucketName } of keys) {
        try {
            await getLoadedBucket(account, bucketName);
        } catch (e) {
            console.error(`Activating bucket ${account}/${bucketName} (active on our predecessor) failed: ${(e as Error).stack ?? e}`);
        }
    }
}

/** Started by deployTakeover once we are actually a deploy successor listening on an alternate port. Until then there are no switchover windows to write or expire, so nothing polls. */
export const startIntermediateMaintenance = lazy(() => {
    void (async () => {
        await activatePredecessorBuckets();
        await maintainIntermediates();
    })().catch((e: Error) => console.error(`Writing the intermediate into the config files failed: ${e.stack ?? e}`));
    runInfinitePoll(INTERMEDIATE_MAINTAIN_INTERVAL, maintainIntermediates);
});

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
    /** The routing config the bucket is RUNNING on, straight from memory - including switchover windows written since it loaded */
    routing: RemoteConfig;
    /** Our own entries in that config, and their summarized current role (routes union + flags) */
    selfEntries: HostedConfig[];
    self?: SelfSummary;
    config: ArchivesConfig;
};

function toActiveBucketInfo(loaded: BucketState): ActiveBucketInfo {
    return {
        folder: getBucketFolder(loaded.account, loaded.bucketName),
        routing: loaded.routing,
        selfEntries: loaded.selfEntries,
        self: loaded.self,
        config: getBucketConfig(loaded),
    };
}

/** The live in-memory state of ONE bucket, answered without touching the disk (no routing file read, no statfs, no stored write stats). Returns an error string when the bucket is not loaded here, which is the normal state for a bucket nothing has accessed since startup. */
export async function getActiveBucket(account: string, bucketName: string): Promise<ActiveBucketInfo | string> {
    let key = `${account}/${bucketName}`;
    let loadedPromise = buckets.get(key);
    if (!loadedPromise) {
        return `Bucket ${key} is not loaded on this server, so it has no live state (it loads on first access)`;
    }
    let loaded: BucketState | undefined;
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

/** Loads a bucket that exists on this server's disk into memory, which starts its synchronization and window timers, and returns its live state. Nothing is written and no other server is contacted - unlike building an ArchivesChain for it, which would probe every source and could write the routing config. Already-loaded buckets just return their state. */
export async function activateBucket(account: string, bucketName: string): Promise<ActiveBucketInfo | string> {
    let key = `${account}/${bucketName}`;
    let wasLoaded = buckets.has(key);
    let loaded: BucketState | undefined;
    try {
        loaded = await getLoadedBucket(account, bucketName);
    } catch (e) {
        return `Bucket ${key} failed to load on this server: ${String((e as Error).stack ?? e).slice(0, 500)}`;
    }
    if (!loaded) {
        return `Bucket ${key} does not exist on this server (no routing file in ${getBucketFolder(account, bucketName)})`;
    }
    // Wait for the indexes to load, so the totals we return are the real ones rather than zeroes from stores that have not read their index yet. The source scans keep running in the background.
    for (let s of loaded.stores) {
        if (s.store instanceof BlobStore) {
            await s.store.init();
        }
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
    // Per-route folders (bucketName-route-<start>-<end>) belong to the same bucket as the plain folder - collapse them so one bucket lists once
    names = [...new Set(names.map(x => x.replace(/-route-[\d.]+-[\d.]+$/, "")))];
    try {
        return await Promise.all(names.map(async bucketName => {
            let key = `${account}/${bucketName}`;
            let folder = getBucketFolder(account, bucketName);
            let base: ServerBucketInfo = { bucketName, active: false, folder };
            base.disk = await timed("statfs", () => getDiskInfo(folder)).catch((e: Error) => {
                base.diskError = String(e.stack ?? e).slice(0, 500);
                return undefined;
            });
            base.writeStats = getBucketWriteStats(key);
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

// In memory only: totals since this process started (or the last clearWriteStats). Persisting them to disk was more machinery than the numbers were worth.
const writeStats = new Map<string, BucketWriteStats>();

function countBucketWrite(key: string, kind: "original" | "flushed", bytes: number): void {
    let stats = writeStats.get(key);
    if (!stats) {
        stats = emptyWriteStats();
        writeStats.set(key, stats);
    }
    if (kind === "original") {
        stats.originalWrites++;
        stats.originalBytes += bytes;
    } else {
        stats.flushedWrites++;
        stats.flushedBytes += bytes;
    }
}

function getBucketWriteStats(key: string): BucketWriteStats {
    return writeStats.get(key) || emptyWriteStats();
}

/** Zeroes the write statistics of every bucket in the account. */
export function clearAccountWriteStats(account: string): number {
    let prefix = `${account}/`;
    let cleared = 0;
    for (let key of [...writeStats.keys()]) {
        if (!key.startsWith(prefix)) continue;
        writeStats.delete(key);
        cleared++;
    }
    console.log(`Cleared the write statistics of ${cleared} buckets in account ${account}`);
    return cleared;
}

const LARGE_FILE_PART_SIZE = 8 * 1024 * 1024;

// Wraps a locally hosted bucket in the IArchives interface, so code written against IArchives (the chain, sync sources, holder reads) talks to it directly instead of becoming a network client to ourselves.
class BucketIArchivesWrapper implements IArchives {
    constructor(private account: string, private bucketName: string, private sourceConfig: SourceConfig) { }

    private findStore(): Promise<LoadedStore> {
        return findBucketStore(this.account, this.bucketName, this.sourceConfig);
    }

    public getDebugName() {
        return `localBucket account ${this.account} bucket ${this.bucketName} route ${JSON.stringify(this.sourceConfig.route || FULL_ROUTE)}`;
    }
    public async get(fileName: string, config?: GetConfig): Promise<Buffer | undefined> {
        let result = await this.get2(fileName, config);
        return result && result.data || undefined;
    }
    public async get2(fileName: string, config?: GetConfig): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        if (fileName === ROUTING_FILE) {
            return await getRoutingFileResult(this.account, this.bucketName);
        }
        if (config?.internal) {
            return await readBucketInternal(this.account, this.bucketName, { path: fileName, range: config.range, includeTombstones: config.includeTombstones });
        }
        return await (await this.findStore()).store.get2({ path: fileName, ...config });
    }
    public async set(fileName: string, data: Buffer, config?: SetConfig): Promise<string> {
        assertWritesAllowed();
        if (fileName === ROUTING_FILE) {
            await queueRoutingConfigWrite(this.account, this.bucketName, data, config);
            return fileName;
        }
        await (await this.findStore()).store.set({ ...config, path: fileName, data });
        return fileName;
    }
    public async del(fileName: string, config?: DelConfig): Promise<void> {
        assertWritesAllowed();
        await (await this.findStore()).store.del({ path: fileName, ...config });
    }
    public async setLargeFile(config: { path: string; lastModified?: number; getNextData(): Promise<Buffer | undefined> }): Promise<void> {
        assertWritesAllowed();
        let store = (await this.findStore()).store;
        let id = await store.startLargeUpload({ path: config.path, lastModified: config.lastModified });
        try {
            while (true) {
                let data = await config.getNextData();
                if (!data) break;
                for (let offset = 0; offset < data.length; offset += LARGE_FILE_PART_SIZE) {
                    await store.appendLargeUpload({ id, data: data.subarray(offset, offset + LARGE_FILE_PART_SIZE) });
                }
            }
            await store.finishLargeUpload({ id, path: config.path, lastModified: config.lastModified });
        } catch (e) {
            await store.cancelLargeUpload({ id });
            throw e;
        }
    }
    public async getInfo(fileName: string, config?: GetInfoConfig): Promise<{ writeTime: number; size: number } | undefined> {
        if (fileName === ROUTING_FILE) {
            let result = await getRoutingFileResult(this.account, this.bucketName);
            return result && { writeTime: result.writeTime, size: result.size } || undefined;
        }
        return await (await this.findStore()).store.getInfo({ path: fileName, ...config });
    }
    public async findInfo(prefix: string, config?: FindConfig): Promise<ArchiveFileInfo[]> {
        return await (await this.findStore()).store.findInfo({ prefix, ...config });
    }
    public async find(prefix: string, config?: FindConfig): Promise<string[]> {
        return (await this.findInfo(prefix, config)).map(x => x.path);
    }
    public async getURL(filePath: string): Promise<string> {
        let { domain, port } = getStorageServerConfig();
        return buildFileUrl(`https://${domain}:${port}/file/${encodeURIComponent(this.account)}/${encodeURIComponent(this.bucketName)}`, filePath);
    }
    public async getConfig(): Promise<ArchivesConfig> {
        return getBucketConfig(await requireBucket(this.account, this.bucketName));
    }
    public async hasWriteAccess(): Promise<boolean> {
        return true;
    }
    public async getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]> {
        return await (await this.findStore()).store.getChangesAfter2(config);
    }
    public async getSyncStatus(): Promise<ArchivesSyncStatus> {
        return await bucketSyncStatus(await requireBucket(this.account, this.bucketName));
    }
}

const localArchives = new Map<string, IArchives>();
export function getLocalArchives(account: string, bucketName: string, sourceConfig: SourceConfig): IArchives {
    let key = `${account}/${bucketName}|${stableStringify(sourceConfig)}`;
    let existing = localArchives.get(key);
    if (existing) return existing;
    let archives = new BucketIArchivesWrapper(account, bucketName, sourceConfig);
    localArchives.set(key, archives);
    return archives;
}
