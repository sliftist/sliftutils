import path from "path";
import fs from "fs";
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
import { ROUTING_FILE, parseRoutingData, parseHostedUrl, buildFileUrl, getConfigVersion, getRoute, routeContains, routeIntersection } from "./remoteConfig";
import { applyDeployRemap, getTakeoverAltPort, getOwnWindowEndClip, onTakeoverEvent } from "./deployTakeover";
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
    // The store plan minus its valid windows (see StorePlan.structureKey): when only windows
    // change, the store is updated in place instead of rebuilt
    structureKey: string;
};

const buckets = new Map<string, Promise<LoadedBucket | undefined>>();

// setTimeout cannot represent longer delays; more distant window boundaries re-check after this
const MAX_REBUILD_TIMER_DELAY = 2 ** 31 - 1;
// Rebuild slightly after the boundary, so the newly-valid entry is unambiguously active
const REBUILD_BOUNDARY_BUFFER = 1000;

function getBucketFolder(account: string, bucketName: string): string {
    return path.join(getStorageServerConfig().folder, "buckets2", account, bucketName);
}

// Ports we are listening on beyond the main config port - a deploy-takeover successor serves on a
// temporary alternate port, and must recognize alternate-port source URLs as itself
const extraListenPorts = new Set<number>();
export function addExtraListenPort(port: number): void {
    extraListenPorts.add(port);
}
function findSelfIndexes(routing: RemoteConfig, account: string, bucketName: string): number[] {
    let { domain, port } = getStorageServerConfig();
    let indexes: number[] = [];
    // The takeover's alternate port is the OTHER process of the switchover, on OUR machine with
    // OUR disk - self for sync purposes on both sides (the old node must not scan/push its own
    // successor; the shared folder plus the switchover disk scans reconcile them)
    let takeoverAltPort = getTakeoverAltPort();
    for (let i = 0; i < routing.sources.length; i++) {
        let source = routing.sources[i];
        if (typeof source === "string" || source.type !== "remote") continue;
        let parsed = parseHostedUrl(source.url);
        if (parsed.address !== domain || parsed.account !== account || parsed.bucketName !== bucketName) continue;
        if (parsed.port === port || extraListenPorts.has(parsed.port) || parsed.port === takeoverAltPort) {
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
            await scheduleRoutingReload(loaded.account, loaded.bucketName, { force: true, reason: "a valid window boundary passed" });
        })();
    }, Math.min(nextBoundary - now + REBUILD_BOUNDARY_BUFFER, MAX_REBUILD_TIMER_DELAY));
    (timer as { unref?: () => void }).unref?.();
}

// Extra scans around each of OUR valid-window starts (a deploy switchover is just this too - its
// remap adds valid windows), catching last-moment writes the previous window's owner accepted near
// the boundary. By the final scan the previous owner has flushed everything (fast writes never
// delay past a window's end), so nothing is missed.
const BOUNDARY_SCAN_OFFSETS = [-30 * 1000, 2 * 1000, 30 * 1000];
// How far back a boundary scan asks the previous owner for changes: anything older has already
// arrived through normal synchronization, and this covers the longest a write can sit unflushed
const BOUNDARY_SCAN_LOOKBACK = DEFAULT_FAST_WRITE_DELAY + WINDOW_END_FLUSH_MARGIN;
// The catch-up scan for a window that was already active when we built the store
const STARTUP_BOUNDARY_SCAN_DELAY = 30 * 1000;

// Each (bucket, boundary, offset) is scheduled exactly once, surviving store rebuilds - the timer
// re-resolves the bucket (and recomputes owners from the then-current routing) when it fires
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
    // A window we are ALREADY inside when the store is built (startup, or a config that made us
    // valid immediately) got none of the lead-up scans - so one runs shortly after, in case we
    // came up just as the previous owner is realizing it must shut down. Only recent boundaries
    // qualify: older trailing writes have long since propagated through normal synchronization.
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
                    // Timer length is capped (far-future boundaries), so re-arm until the time
                    // actually arrives
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
        // Boundary scans never run in parallel; a slow one simply swallows later scheduled points
        console.log(`Skipping boundary scan (${label}): the previous boundary scan is still running`);
        return;
    }
    boundaryScansRunning.add(bucketKey);
    try {
        let loaded = await buckets.get(bucketKey);
        if (!loaded) return;
        let store = loaded.store;
        if (!(store instanceof BlobStore)) return;
        // Owners are recomputed at fire time - the routing (or the takeover remap) may have
        // changed since this scan was scheduled
        let effective = applyDeployRemap(loaded.routing);
        let selfIndexes = findSelfIndexes(effective, loaded.account, loaded.bucketName);
        let selfIndexSet = new Set(selfIndexes);
        let selves = selfIndexes.map(i => effective.sources[i] as HostedConfig).filter(x => x.validWindow[0] === windowStart);
        if (!selves.length) return;
        let prevTime = windowStart - 1;
        let needDiskScan = false;
        // sourceIndex -> the slice of our route that source owned in the previous window
        let remoteOwners = new Map<number, [number, number]>();
        for (let self of selves) {
            let selfRoute = self.route || FULL_ROUTE;
            let idx = effective.sources.indexOf(self);
            // These scans only run on the write node - the first source valid at the new window's
            // start for our route. An earlier entry fully covering our route means writes go there,
            // and IT does the boundary scans.
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
            // The previous window's owners: walking the config in order (write-target order),
            // each source claims whatever slice of our route no earlier source already owns
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
                    // The previous owner shares our storage (same machine + bucket, e.g. the other
                    // process of a deploy switchover), so a disk rescan sees its writes
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
    effective: RemoteConfig;
    selfEntries: HostedConfig[];
    self: HostedConfig | undefined;
    rawDisk: boolean;
    // The BlobStore sources this plan builds: [0] is the disk, the rest are downstream configs
    sourceSpecs: { sourceConfig?: HostedConfig | BackblazeConfig; validWindow: [number, number]; route?: [number, number]; noFullSync?: boolean }[];
    readerDiskLimit?: number;
    // Everything about the plan EXCEPT the valid windows. Two plans with equal structure keys
    // differ only in windows, which the running store applies in place - it must survive the
    // routine config evolution of reducing the last forever-window and appending a new entry,
    // instead of being disposed and rebuilt (losing sync state and rescanning everything).
    structureKey: string;
};

// The stable identity of a source endpoint: its config with the in-place-updatable parts
// (windows, routes) stripped, so a source is recognized across config changes
function sourceIdentity(sourceConfig: HostedConfig | BackblazeConfig | undefined): string {
    if (!sourceConfig) return "disk";
    return JSON.stringify({ ...sourceConfig, validWindow: undefined, route: undefined });
}

function computeStorePlan(account: string, bucketName: string, routing: RemoteConfig): StorePlan {
    // The deploy-takeover remap is an INTERPRETATION overlay: everything behavioral (self entries,
    // windows, downstream sources) uses the remapped view, while loaded.routing/routingJSON stay
    // the STORED config - so version guards, change detection, and synchronization never see (or
    // persist) the remap
    let effective = applyDeployRemap(routing);
    let selfIndexes = findSelfIndexes(effective, account, bucketName);
    let selfEntries = selfIndexes.map(i => effective.sources[i] as HostedConfig);
    let self = selectEntryAt(selfEntries, Date.now());
    let selfIndex = -1;
    if (self) {
        selfIndex = effective.sources.indexOf(self);
    }
    // Our own disk is the base source; only the routing entries DOWNSTREAM from us (after our
    // currently-valid entry) become synchronization sources. Upstream sources sync from us, so
    // writing to or scanning them would just echo our own data back (and make our availability
    // depend on theirs). A server NOT in the list has been removed from the bucket: it keeps
    // its disk data (the config may re-add it), but stops all synchronization - no one
    // contacts a removed source, and scanning/pushing as if we were still one would fight the
    // real chain. The config-level validWindow rides on each ArchivesSource; the disk source
    // shares our currently-valid entry's window (it holds our copy of the data).
    // Our own disk gets no route filter: everything it holds is ours to index and serve.
    // Being removed from the config entirely is a valid window of NOTHING ([0, 0]): fast
    // writes flush immediately (nothing may sit in memory on a node that's been cut out),
    // while the disk data and index stay served.
    // Internally every self entry is the SAME store - one process listening on one or more ports
    // (a takeover's alternate-port middle window included). So the disk window merges all
    // contiguous own windows: an options boundary or the port split must never force a pointless
    // internal flush between two windows that are both us. Only the DYING process of a takeover
    // clips its end - from the write handoff on, the data belongs to the successor process.
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
        let clip = getOwnWindowEndClip();
        if (clip !== undefined && clip < end) {
            end = clip;
        }
        diskWindow = [start, end];
    }
    let ownIndexes = new Set(selfIndexes);
    let sourceSpecs: StorePlan["sourceSpecs"] = [{
        validWindow: diskWindow,
    }];
    if (selfIndex !== -1) {
        for (let i = selfIndex + 1; i < effective.sources.length; i++) {
            let source = effective.sources[i];
            if (typeof source === "string" || ownIndexes.has(i)) continue;
            // Disjoint-shard sources never talk to each other; a partial overlap syncs only
            // the intersection (scans ignore the rest, writes only send matching keys)
            let sharedRoute = routeIntersection(self?.route, source.route);
            if (!sharedRoute) continue;
            // A bounded-cache server (noFullSync on our own entry) must not full-sync from
            // ANY source, or its disk would fill regardless of the limit
            sourceSpecs.push({ sourceConfig: source, validWindow: source.validWindow, route: sharedRoute, noFullSync: source.noFullSync || self?.noFullSync });
        }
    }
    let rawDisk = !!self?.rawDisk;
    // Only what the running store genuinely cannot change in place: the store TYPE (rawDisk) and
    // whether the disk-limit poll runs. Source additions/removals and window/route changes are all
    // applied live via updateSources - a config change must never destroy the running store.
    let structureKey = JSON.stringify({
        rawDisk,
        readerDiskLimit: self?.readerDiskLimit,
    });
    return { effective, selfEntries, self, rawDisk, sourceSpecs, readerDiskLimit: self?.readerDiskLimit, structureKey };
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
                // Fires for our own routing writes AND routing files pulled in via synchronization
                // (only ever newer ones, see IArchives.set) — either way, apply the new config
                if (key !== ROUTING_FILE) return;
                void scheduleRoutingReload(account, bucketName);
            },
            readerDiskLimit: plan.readerDiskLimit,
        });
    }
    let loaded: LoadedBucket = { account, bucketName, routing, routingJSON: JSON.stringify(routing), selfEntries, self, store, structureKey: plan.structureKey };
    scheduleWindowBoundaryRebuild(loaded);
    scheduleBoundaryScans(loaded);
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
    // The routing config is only ever read off our own disk - it is never pulled from another
    // source (it reaches us exclusively as a version-validated write, which lands on disk first)
    let data = await new ArchivesDisk(getBucketFolder(account, bucketName)).get(ROUTING_FILE);
    if (!data) return;
    let routing = parseRoutingData(data);
    if (!config?.force && JSON.stringify(routing) === loaded.routingJSON) return;
    let reason = config?.force && (config.reason || "forced") || "routing config changed";
    let plan = computeStorePlan(account, bucketName, routing);
    // Config changes are applied to the RUNNING store in place - windows/routes mutate, added
    // sources start syncing, removed sources' slots go dead - so the index, pending fast writes
    // (re-capped to the new deadline), and unaffected sync loops all survive. The store is only
    // destroyed for what it structurally cannot express (a rawDisk flip).
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
        return;
    }
    console.log(`Rebuilding the store for bucket ${key} (${reason})`);
    if (loaded.store instanceof BlobStore) {
        await loaded.store.dispose();
    }
    buckets.set(key, Promise.resolve(buildBucket(account, bucketName, routing, plan)));
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

// Wrong-target rejections are rare and important (they ARE the switchover handoff), but a burst of
// racing writes at a boundary must not flood the log - so at most one line a minute
const WRONG_TARGET_LOG_THROTTLE = 60 * 1000;
let lastWrongTargetLog = 0;
function logWrongTargetRejection(message: string): void {
    if (Date.now() - lastWrongTargetLog < WRONG_TARGET_LOG_THROTTLE) return;
    lastWrongTargetLog = Date.now();
    console.log(message);
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
        // The remapped (interpretation) view: getConfig is how clients learn of an in-progress
        // deploy takeover, since the remap is never written into the routing file itself
        remoteConfig: applyDeployRemap(bucket.routing),
        index: progress?.index,
        indexSources: progress?.sources,
        readerDiskLimit: progress?.readerDiskLimit,
        syncing: progress?.syncing,
    };
}

export async function rebuildAllLoadedBuckets(): Promise<void> {
    for (let key of [...buckets.keys()]) {
        let slash = key.indexOf("/");
        await scheduleRoutingReload(key.slice(0, slash), key.slice(slash + 1), { force: true, reason: "deploy takeover state changed" });
    }
}

onTakeoverEvent(event => {
    if (event === "remapChanged") {
        // The rebuild applies the remapped windows, and scheduleBoundaryScans (part of the
        // rebuild) schedules the handoff scans around the new windows' starts
        void rebuildAllLoadedBuckets();
    }
});

export type ServerBucketInfo = {
    bucketName: string;
    // Loaded in memory (created or accessed since startup), so its synchronization is running
    active: boolean;
    config?: ArchivesConfig;
    error?: string;
};

/** Every bucket the account has on this server, active or not, each with its configuration.
 *  Inactive buckets are inspected straight from disk WITHOUT loading them - loading would start
 *  their synchronization, and old invalid buckets must stay inert (their parse error is reported
 *  instead). */
export async function listAccountBuckets(account: string): Promise<ServerBucketInfo[]> {
    let accountFolder = path.join(getStorageServerConfig().folder, "buckets2", account);
    let names: string[];
    try {
        names = await fs.promises.readdir(accountFolder);
    } catch {
        return [];
    }
    let results: ServerBucketInfo[] = [];
    for (let bucketName of names) {
        let loadedPromise = buckets.get(`${account}/${bucketName}`);
        if (loadedPromise) {
            try {
                let loaded = await loadedPromise;
                if (loaded) {
                    results.push({ bucketName, active: true, config: getBucketConfig(loaded) });
                    continue;
                }
            } catch (e) {
                results.push({ bucketName, active: true, error: String((e as Error).stack ?? e).slice(0, 500) });
                continue;
            }
        }
        try {
            let data = await new ArchivesDisk(getBucketFolder(account, bucketName)).get(ROUTING_FILE);
            if (!data) {
                results.push({ bucketName, active: false, error: `No routing file (${ROUTING_FILE})` });
                continue;
            }
            results.push({ bucketName, active: false, config: { remoteConfig: parseRoutingData(data) } });
        } catch (e) {
            results.push({ bucketName, active: false, error: String((e as Error).stack ?? e).slice(0, 500) });
        }
    }
    return results;
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
        // Missing buckets say true, matching what they become once created (the default store type)
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
