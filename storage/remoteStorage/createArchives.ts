module.allowclient = true;

import { isNode, sort } from "socket-function/src/misc";
import {
    IArchives, RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig,
    ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, WRITE_PAST_WINDOW_GRACE, STORAGE_WRONG_VALID_WINDOW,
    STORAGE_WRONG_ROUTE, FULL_ROUTE, VARIABLE_SHARD,
} from "../IArchives";
import {
    ROUTING_FILE, getConfigVersion, parseHostedUrl, parseBackblazeUrl,
    normalizeRemoteConfig, normalizeSource, parseRoutingData, serializeRemoteConfig,
    getRoute, routeContains, parseVariableRoute,
} from "./remoteConfig";
import { SocketFunction } from "socket-function/SocketFunction";
import { ArchivesRemote, parseStorageUrl, authenticateStorage } from "./ArchivesRemote";
import { ArchivesBackblaze } from "../backblaze";
import { getStorageServerConfigOptional, getLocalArchives, ServerBucketInfo } from "./storageServerState";
import { RemoteStorageController, STORAGE_NOT_AUTHENTICATED } from "./storageController";
import { SourceWrapper, RETRY_START_DELAY, RETRY_MAX_DELAY, RETRY_GROWTH } from "./sourceWrapper";

// Turns a RemoteConfig into a usable IArchives (createArchives). Initialization is lazy: on the
// first call we walk the sources IN ORDER and the first one that answers is authoritative (sources
// are synchronized copies of the same bucket, so we never consult the rest). Its stored routing
// config wins over the in-memory one - unless ours has a strictly newer version, in which case we
// write ours (creating the bucket when no routing exists at all). A failed init (all sources down,
// or the routing write was rejected) stays failed for callers but retries itself in the background
// with a ramping delay. Once running, we re-read the routing config every CONFIG_POLL_INTERVAL and
// rebuild the source list when it changed (reusing wrappers for unchanged sources).

const CONFIG_POLL_INTERVAL = 5 * 60 * 1000;

// The direct API IArchives for one source, with no URL-form fallback and no chaining. Used by the
// storage server for its synchronization sources. Denied calls throw immediately (registering the
// access request in the background): the sync loops retry-and-log until access is granted, while
// explicit writes surface the denial (with grant instructions) to the caller instead of hanging.
export function createApiArchives(source: HostedConfig | BackblazeConfig): IArchives {
    if (source.type === "backblaze") {
        return new ArchivesBackblaze({ bucketName: parseBackblazeUrl(source.url).bucketName, public: source.public, immutable: source.immutable });
    }
    let parsed = parseHostedUrl(source.url);
    let server = isNode() && getStorageServerConfigOptional() || undefined;
    if (server && parsed.address === server.domain && parsed.port === server.port) {
        // This source is a bucket hosted by our own process - use it directly instead of calling
        // ourselves over HTTPS
        return getLocalArchives(parsed.account, parsed.bucketName);
    }
    return new ArchivesRemote({ url: source.url, accountName: source.accountName, waitForAccess: false });
}

type ChainState = {
    config: RemoteConfig;
    sources: SourceWrapper[];
};

function configWindowCurrent(config: HostedConfig | BackblazeConfig): boolean {
    let now = Date.now();
    let [start, end] = config.validWindow;
    return start - WRITE_PAST_WINDOW_GRACE <= now && now <= end + WRITE_PAST_WINDOW_GRACE;
}

// Client writes target only the CURRENTLY valid source: a future-window source receives its data
// through server-side downstream propagation/backfill, never directly from clients
function configAcceptsWrites(config: HostedConfig | BackblazeConfig): boolean {
    return configWindowCurrent(config);
}

export class ArchivesChain implements IArchives {
    private configured: RemoteConfig;
    // The config we actually run on (the authoritative stored one after init)
    private activeConfig: RemoteConfig;
    private statePromise: Promise<ChainState> | undefined;
    private initRetryDelay = RETRY_START_DELAY;
    private initRetryTimer: ReturnType<typeof setTimeout> | undefined;
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private disposed = false;

    constructor(config: RemoteConfig | RemoteConfigBase) {
        this.configured = normalizeRemoteConfig(config);
        this.activeConfig = this.configured;
    }

    public getDebugName() {
        let urls = this.activeConfig.sources.map(x => typeof x === "string" && x || (x as HostedConfig | BackblazeConfig).url);
        return `chain/${urls.join(",")}`;
    }

    // Lazy init that rethrows its error to every caller, while a background timer resets and
    // retries it with a ramping delay - so a chain that couldn't initialize fixes itself once a
    // source comes back, without any caller having to drive it.
    private getState(): Promise<ChainState> {
        if (this.disposed) {
            return Promise.reject(new Error(`ArchivesChain ${this.getDebugName()} has been disposed`));
        }
        if (!this.statePromise) {
            let promise = this.init();
            this.statePromise = promise;
            promise.then(() => {
                this.initRetryDelay = RETRY_START_DELAY;
            }, (e: Error) => {
                if (this.disposed || this.initRetryTimer) return;
                console.error(`Storage init failed for ${this.getDebugName()}, retrying in ${Math.round(this.initRetryDelay / 1000)}s. ${e.stack ?? e}`);
                this.initRetryTimer = setTimeout(() => {
                    this.initRetryTimer = undefined;
                    if (this.disposed) return;
                    if (this.statePromise === promise) {
                        this.statePromise = undefined;
                    }
                    this.getState().catch(() => { });
                }, this.initRetryDelay);
                (this.initRetryTimer as { unref?: () => void }).unref?.();
                this.initRetryDelay = Math.min(RETRY_MAX_DELAY, this.initRetryDelay * RETRY_GROWTH);
            });
        }
        return this.statePromise;
    }

    private async init(): Promise<ChainState> {
        let configs = this.configured.sources.map(normalizeSource);
        let probeErrors: string[] = [];
        let found: { probe: SourceWrapper; existing: RemoteConfig | undefined } | undefined;
        for (let sourceConfig of configs) {
            let probe = await SourceWrapper.create(sourceConfig, { background: false });
            try {
                let data = await probe.read(archives => archives.get(ROUTING_FILE));
                found = { probe, existing: data && parseRoutingData(data) || undefined };
                break;
            } catch (e) {
                probeErrors.push(`${sourceConfig.url}: ${(e as Error).stack ?? e}`);
                probe.dispose();
            }
        }
        if (!found) {
            throw new Error(`Cannot initialize storage for ${this.getDebugName()}: no source answered. ${probeErrors.join(" | ")}`);
        }
        let active = this.configured;
        let { probe, existing } = found;
        let needsWrite = true;
        if (existing && getConfigVersion(existing) >= getConfigVersion(this.configured)) {
            if (getConfigVersion(existing) === getConfigVersion(this.configured) && JSON.stringify(existing) !== JSON.stringify(this.configured)) {
                console.error(`Archives configuration updated without updating the version, for ${probe.config.url}. Updates will be ignored until you increase the version. Using: ${JSON.stringify(existing)}, ignoring: ${JSON.stringify(this.configured)}`);
            }
            active = existing;
            needsWrite = false;
        }
        let sources = await this.buildSources(active);
        if (needsWrite) {
            // We decided to write (ours is newer than the authoritative first-up source's, or no
            // routing exists yet). The write goes to all sources, so now EVERY reachable source's
            // stored routing is read, and the write is refused unless our version is strictly
            // greater than all of them - a source already at (or past) our version means this
            // version number is taken, and writing anyway would leave sources at the same version
            // with different content, each rejecting the other's pushes forever.
            let best: RemoteConfig | undefined;
            let conflictUrl: string | undefined;
            for (let source of sources) {
                let data: Buffer | undefined;
                try {
                    data = await source.read(archives => archives.get(ROUTING_FILE));
                } catch {
                    // Down sources are still protected by the server-side version guard when the
                    // write eventually reaches them
                    continue;
                }
                if (!data) continue;
                let stored = parseRoutingData(data);
                if (!best || getConfigVersion(stored) > getConfigVersion(best)) {
                    best = stored;
                }
                if (getConfigVersion(stored) === getConfigVersion(this.configured) && JSON.stringify(stored) !== JSON.stringify(this.configured)) {
                    conflictUrl = source.config.url;
                }
            }
            if (best && getConfigVersion(best) >= getConfigVersion(this.configured)) {
                if (conflictUrl && getConfigVersion(best) === getConfigVersion(this.configured)) {
                    console.error(`Archives configuration updated without updating the version, for ${conflictUrl}. Updates will be ignored until you increase the version. Using: ${JSON.stringify(best)}, ignoring: ${JSON.stringify(this.configured)}`);
                }
                active = best;
                needsWrite = false;
                for (let source of sources) {
                    source.dispose();
                }
                sources = await this.buildSources(active);
            }
        }
        if (needsWrite) {
            // The update only happens when EVERY source would accept it - a partial update would
            // leave the sources out of sync, and a client without access retrying the write forever
            // would never initialize. Without full access we run on the stored config (when there
            // is one) and log the problem instead.
            let missing: string[] = [];
            for (let source of sources) {
                try {
                    if (!await source.hasWriteAccess()) {
                        missing.push(source.config.url);
                    }
                } catch (e) {
                    missing.push(`${source.config.url} (check failed: ${(e as Error).stack ?? e})`);
                }
            }
            if (missing.length) {
                console.error(`Not writing the storage routing config for ${this.getDebugName()} (version ${getConfigVersion(this.configured)}): no write access to ${missing.join(", ")}. ${existing && `Running on the stored config (version ${getConfigVersion(existing)}) instead.` || `No stored config exists, so the bucket cannot be created until write access is granted.`}`);
                if (existing) {
                    active = existing;
                    for (let source of sources) {
                        source.dispose();
                    }
                    sources = await this.buildSources(active);
                }
            } else {
                try {
                    // A rejected write fails init, which retries from scratch - re-reading the
                    // routing, so losing a create race to another client just adopts their config
                    // on the next attempt.
                    await probe.write(archives => archives.set(ROUTING_FILE, serializeRemoteConfig(this.configured)));
                } catch (e) {
                    for (let source of sources) {
                        source.dispose();
                    }
                    probe.dispose();
                    throw e;
                }
            }
        }
        probe.dispose();
        this.activeConfig = active;
        this.startConfigPoll();
        return { config: active, sources };
    }

    private async buildSources(config: RemoteConfig): Promise<SourceWrapper[]> {
        let sources: SourceWrapper[] = [];
        for (let sourceConfig of config.sources.map(normalizeSource)) {
            let source = await SourceWrapper.create(sourceConfig);
            // Latency (for variable-shard target preference) is tracked from initialization on
            source.startPinging();
            sources.push(source);
        }
        return sources;
    }

    private startConfigPoll(): void {
        if (this.pollTimer || this.disposed) return;
        this.pollTimer = setInterval(() => {
            void this.checkForNewConfig().catch((e: Error) => {
                console.error(`Checking for a new storage routing config failed for ${this.getDebugName()}: ${e.stack ?? e}`);
            });
        }, CONFIG_POLL_INTERVAL);
        (this.pollTimer as { unref?: () => void }).unref?.();
    }

    private async checkForNewConfig(): Promise<void> {
        if (this.disposed || !this.statePromise) return;
        let state: ChainState;
        try {
            state = await this.statePromise;
        } catch {
            // Init is failing; its own retry loop handles that
            return;
        }
        let data = await this.run(state, {}, archives => archives.get(ROUTING_FILE));
        if (!data) return;
        let latest = parseRoutingData(data);
        if (JSON.stringify(latest) === JSON.stringify(state.config)) return;
        console.log(`Storage routing config changed for ${this.getDebugName()}, rebuilding sources`);
        let oldByConfig = new Map(state.sources.map(source => [JSON.stringify(source.config), source]));
        let sources: SourceWrapper[] = [];
        for (let sourceConfig of latest.sources.map(normalizeSource)) {
            let key = JSON.stringify(sourceConfig);
            let old = oldByConfig.get(key);
            if (old) {
                oldByConfig.delete(key);
                sources.push(old);
            } else {
                sources.push(await SourceWrapper.create(sourceConfig));
            }
        }
        // In-flight requests still hold the old wrappers and finish fine; dispose just stops any
        // background reconnect loops
        for (let leftover of oldByConfig.values()) {
            leftover.dispose();
        }
        this.activeConfig = latest;
        this.statePromise = Promise.resolve({ config: latest, sources });
    }

    // Runs a request against the first available source (that covers the key's route, when one is
    // given), moving to the next one ONLY when the source's WebSocket is down (checked directly -
    // never by inspecting the error, which is arbitrary data). An error from a connected source is
    // an application error and throws as-is. A down source gets its background reconnect kicked.
    private async run<T>(state: ChainState, config: { apiOnly?: boolean; write?: boolean; route?: number }, run: (archives: IArchives) => Promise<T>): Promise<T> {
        if (config.write) {
            return await this.runWrite(state, config.route, run);
        }
        let errors: string[] = [];
        for (let source of state.sources) {
            if (config.route !== undefined && !routeContains(source.config.route, config.route)) continue;
            if (!configWindowCurrent(source.config)) continue;
            if (!source.isConnected()) {
                source.noteFailure();
                errors.push(`${source.config.url} is not connected`);
                continue;
            }
            try {
                if (config.apiOnly) {
                    let api = source.api;
                    if (!api) {
                        errors.push(`${source.config.url} has URL-only access, which cannot serve this operation`);
                        continue;
                    }
                    return await run(api);
                }
                return await source.read(run);
            } catch (e) {
                if (source.isConnected()) throw e;
                source.noteFailure();
                errors.push(String((e as Error).stack ?? e));
            }
        }
        throw new Error(`All sources failed for ${this.getDebugName()}${config.route !== undefined && ` (route ${config.route})` || ""}: ${errors.join(" | ") || "no sources available"}`);
    }

    // Writes are consistent: they go to the first currently-valid source covering the key's route
    // and NEVER fail over to another node - a client wrongly deciding nodes are down must not
    // scatter its writes across the chain. (Reads fail over freely above: sources are synchronized
    // copies, so reading from any of them is safe.) The one retry is for a window boundary passing
    // (or a route disagreement) mid-write, which re-resolves the target rather than falling back.
    private async runWrite<T>(state: ChainState, route: number | undefined, run: (archives: IArchives) => Promise<T>): Promise<T> {
        let retriedWrongWindow = false;
        let retriedWrongRoute = false;
        while (true) {
            let target = state.sources.find(x => configAcceptsWrites(x.config) && (route === undefined || routeContains(x.config.route, route)));
            if (!target) {
                throw new Error(`No source accepts writes for ${this.getDebugName()}${route !== undefined && ` (route ${route})` || ""} (every source is outside its valid window or outside the key's route)`);
            }
            if (!target.isConnected()) {
                target.noteFailure();
                throw new Error(`Cannot write: the write target ${target.config.url} is not connected (writes never fail over to other sources)`);
            }
            try {
                return await target.write(run);
            } catch (e) {
                let message = String((e as Error).stack ?? e);
                if (message.includes(STORAGE_WRONG_VALID_WINDOW) && !retriedWrongWindow) {
                    retriedWrongWindow = true;
                    continue;
                }
                if (message.includes(STORAGE_WRONG_ROUTE) && !retriedWrongRoute) {
                    retriedWrongRoute = true;
                    continue;
                }
                if (!target.isConnected()) {
                    target.noteFailure();
                }
                throw e;
            }
        }
    }

    private async request<T>(config: { apiOnly?: boolean; write?: boolean; route?: number }, run: (archives: IArchives) => Promise<T>): Promise<T> {
        let state = await this.getState();
        return await this.run(state, config, run);
    }

    // The access-page link (plus our machineId/ip, for the approver to match the request) for the
    // first hosted source that hasn't granted us access. undefined when we have access everywhere
    // we can have it. Also registers the access request server-side.
    public async waitingForAccess(): Promise<{ link: string; machineId: string; ip: string } | undefined> {
        let state = await this.getState();
        for (let source of state.sources) {
            if (source.api instanceof ArchivesRemote) {
                let waiting = await source.api.waitingForAccess();
                if (waiting) return waiting;
            }
        }
        return undefined;
    }

    public async get(fileName: string, config?: { range?: { start: number; end: number } }): Promise<Buffer | undefined> {
        let result = await this.get2(fileName, config);
        return result && result.data || undefined;
    }
    public async get2(fileName: string, config?: { range?: { start: number; end: number } }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        return await this.request({ route: getRoute(fileName) }, archives => archives.get2(fileName, config));
    }
    public async getInfo(fileName: string): Promise<{ writeTime: number; size: number } | undefined> {
        return await this.request({ route: getRoute(fileName) }, archives => archives.getInfo(fileName));
    }

    // A minimal set of connected, currently-valid API sources whose routes cover [0, 1) - listing
    // operations must merge every shard. Greedy sweep: repeatedly take the source that extends
    // coverage the furthest. In practice this is one source (unsharded), or one per shard.
    private selectCoveringSources(state: ChainState): SourceWrapper[] {
        let candidates = state.sources.filter(x => configWindowCurrent(x.config) && x.api && x.isConnected());
        let chosen: SourceWrapper[] = [];
        let covered = 0;
        while (covered < 1) {
            let best: SourceWrapper | undefined;
            let bestEnd = covered;
            for (let source of candidates) {
                let [start, end] = source.config.route || FULL_ROUTE;
                if (start > covered) continue;
                if (end > bestEnd) {
                    bestEnd = end;
                    best = source;
                }
            }
            if (!best) {
                throw new Error(`Cannot cover the full route space for ${this.getDebugName()}: the available sources only cover up to ${covered} (some shards are down or URL-only)`);
            }
            chosen.push(best);
            covered = bestEnd;
        }
        return chosen;
    }

    private async runOnApi<T>(source: SourceWrapper, run: (archives: IArchives) => Promise<T>): Promise<T> {
        let api = source.api;
        if (!api) {
            throw new Error(`${source.config.url} has URL-only access, which cannot serve this operation`);
        }
        return await run(api);
    }

    public async find(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<string[]> {
        return (await this.findInfo(prefix, config)).map(x => x.path);
    }
    public async findInfo(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        let state = await this.getState();
        let covering = this.selectCoveringSources(state);
        let results = await Promise.all(covering.map(source => this.runOnApi(source, archives => archives.findInfo(prefix, config))));
        // Overlapping shards can both report a path; the newest wins
        let byPath = new Map<string, ArchiveFileInfo>();
        for (let list of results) {
            for (let file of list) {
                let existing = byPath.get(file.path);
                if (!existing || file.createTime > existing.createTime) {
                    byPath.set(file.path, file);
                }
            }
        }
        let merged = [...byPath.values()];
        sort(merged, x => x.path);
        return merged;
    }
    public async getChangesAfter(time: number): Promise<ArchiveFileInfo[]> {
        let state = await this.getState();
        let covering = this.selectCoveringSources(state);
        let results = await Promise.all(covering.map(source => this.runOnApi(source, async archives => {
            if (!archives.getChangesAfter) {
                throw new Error(`${archives.getDebugName()} does not support getChangesAfter`);
            }
            return await archives.getChangesAfter(time);
        })));
        let byPath = new Map<string, ArchiveFileInfo>();
        for (let list of results) {
            for (let file of list) {
                let existing = byPath.get(file.path);
                if (!existing || file.createTime > existing.createTime) {
                    byPath.set(file.path, file);
                }
            }
        }
        let merged = [...byPath.values()];
        sort(merged, x => x.path);
        return merged;
    }
    public async getSyncStatus(): Promise<ArchivesSyncStatus> {
        let state = await this.getState();
        let covering = this.selectCoveringSources(state);
        let statuses = await Promise.all(covering.map(source => this.runOnApi(source, async archives => {
            if (!archives.getSyncStatus) {
                throw new Error(`${archives.getDebugName()} does not support getSyncStatus`);
            }
            return await archives.getSyncStatus();
        })));
        return {
            allScansComplete: statuses.every(x => x.allScansComplete),
            indexSize: statuses.reduce((sum, x) => sum + x.indexSize, 0),
            sources: statuses.flatMap(x => x.sources),
        };
    }
    public async getConfig(): Promise<ArchivesConfig> {
        let state = await this.getState();
        if (!state.sources.some(x => x.api)) return { remoteConfig: state.config };
        let config = await this.run(state, { apiOnly: true }, archives => archives.getConfig());
        return { ...config, remoteConfig: state.config };
    }
    /** True only when EVERY write-receiving source would accept our writes (partial write access
     *  desynchronizes sources, so it counts as no access). */
    public async hasWriteAccess(): Promise<boolean> {
        let state = await this.getState();
        for (let source of state.sources) {
            if (!configAcceptsWrites(source.config)) continue;
            if (!await source.hasWriteAccess()) return false;
        }
        return true;
    }

    private assertNotBareVariableShard(fileName: string): void {
        if (fileName.includes(VARIABLE_SHARD) && parseVariableRoute(fileName) === undefined) {
            throw new Error(`Keys containing VARIABLE_SHARD must be written with setVariableShard, which materializes the shard value and returns the full key. Key: ${JSON.stringify(fileName)}`);
        }
    }

    public async set(fileName: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
        this.assertNotBareVariableShard(fileName);
        await this.request({ write: true, route: getRoute(fileName) }, archives => archives.set(fileName, data, config));
    }
    public async del(fileName: string): Promise<void> {
        await this.request({ write: true, route: getRoute(fileName) }, archives => archives.del(fileName));
    }

    /** Writes a key containing the VARIABLE_SHARD sentinel: picks the lowest-latency up write
     *  shard, materializes the key with a random value inside that shard's route, writes it, and
     *  returns the FULL key actually written (the caller needs it to ever read the value back).
     *  Unlike normal writes this CAN move to another shard when the preferred one is down (error +
     *  socket down, same rule as reads) - each shard receives a different key, so write
     *  consistency is preserved. */
    public async setVariableShard(key: string, data: Buffer, config?: { lastModified?: number }): Promise<string> {
        if (!key.includes(VARIABLE_SHARD)) {
            throw new Error(`Expected the key to contain the VARIABLE_SHARD sentinel, was ${JSON.stringify(key)}`);
        }
        if (parseVariableRoute(key) !== undefined) {
            throw new Error(`The key already has a materialized shard value; write it with set instead. Key: ${JSON.stringify(key)}`);
        }
        let state = await this.getState();
        // Per-shard write consistency still holds: within a route, only the FIRST source may take
        // writes - latency only picks WHICH shard the key materializes into
        let targetsByRoute = new Map<string, SourceWrapper>();
        for (let source of state.sources) {
            if (!configAcceptsWrites(source.config)) continue;
            let routeKey = JSON.stringify(source.config.route || FULL_ROUTE);
            if (!targetsByRoute.has(routeKey)) {
                targetsByRoute.set(routeKey, source);
            }
        }
        let targets = [...targetsByRoute.values()];
        sort(targets, x => x.getLatency());
        let errors: string[] = [];
        for (let target of targets) {
            if (!target.isConnected()) {
                target.noteFailure();
                errors.push(`${target.config.url} is not connected`);
                continue;
            }
            let [start, end] = target.config.route || FULL_ROUTE;
            let fullKey = key.replace(VARIABLE_SHARD, VARIABLE_SHARD + "_" + (start + Math.random() * (end - start)));
            try {
                await target.write(archives => archives.set(fullKey, data, config));
                return fullKey;
            } catch (e) {
                // An error alone doesn't justify moving on (it would be an application error); the
                // socket must also be down
                if (target.isConnected()) throw e;
                target.noteFailure();
                errors.push(String((e as Error).stack ?? e));
            }
        }
        throw new Error(`Every variable-shard write target failed for ${this.getDebugName()}: ${errors.join(" | ") || "no sources accept writes"}`);
    }

    public async setLargeFile(config: { path: string; getNextData(): Promise<Buffer | undefined> }): Promise<void> {
        this.assertNotBareVariableShard(config.path);
        let state = await this.getState();
        // Same consistency rule as runWrite: the first currently-valid source for the route, or nothing
        let route = getRoute(config.path);
        let target = state.sources.find(x => configAcceptsWrites(x.config) && routeContains(x.config.route, route));
        if (!target) {
            throw new Error(`No source accepts writes for setLargeFile on ${this.getDebugName()} (route ${route})`);
        }
        if (!target.isConnected()) {
            target.noteFailure();
            throw new Error(`Cannot write: the write target ${target.config.url} is not connected (writes never fail over to other sources)`);
        }
        await target.write(archives => archives.setLargeFile(config));
    }

    public async getURL(path: string): Promise<string> {
        let state = await this.getState();
        let route = getRoute(path);
        for (let source of state.sources) {
            if (source.config.public === false) continue;
            if (!routeContains(source.config.route, route)) continue;
            if (source.url) return await source.url.getURL(path);
            if (source.api) return await source.api.getURL(path);
        }
        throw new Error(`No public source covering route ${route} to build a URL from for ${this.getDebugName()}`);
    }

    public dispose(): void {
        this.disposed = true;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
        }
        if (this.initRetryTimer) {
            clearTimeout(this.initRetryTimer);
        }
        let statePromise = this.statePromise;
        if (statePromise) {
            void statePromise.then(state => {
                for (let source of state.sources) {
                    source.dispose();
                }
            }, () => { });
        }
    }
}

// The IArchives for a RemoteConfig (or a single source - a routing URL string works). Fully lazy:
// nothing is contacted until the first call. Call dispose() when done with it, so its background
// retry/poll loops stop.
export function createArchives(config: RemoteConfig | RemoteConfigBase): ArchivesChain {
    return new ArchivesChain(config);
}

/** Every bucket an account has on one storage server - active and inactive - with each bucket's
 *  configuration. One authenticated call (the normal trust system applies): no ArchivesChain, no
 *  synchronization, and inactive buckets on the server stay inactive. Any URL addressing the
 *  server works (a bucket routing URL, or just https://host:port). */
export async function listServerBuckets(config: { url: string; account: string }): Promise<ServerBucketInfo[]> {
    SocketFunction.ENABLE_CLIENT_MODE = true;
    let parsed = parseStorageUrl(config.url);
    let nodeId = SocketFunction.connect({ address: parsed.address, port: parsed.port });
    let controller = RemoteStorageController.nodes[nodeId];
    try {
        return await controller.listBuckets(config.account);
    } catch (e) {
        if (!String((e as Error).stack ?? e).includes(STORAGE_NOT_AUTHENTICATED)) throw e;
        await authenticateStorage({ address: parsed.address, port: parsed.port, nodeId });
        return await controller.listBuckets(config.account);
    }
}

/** Live info for one bucket given its routing URL (getConfig: routing config, index totals, disk
 *  limit, in-progress synchronization). One authenticated call to that server - a light, safe
 *  alternative to instantiating an ArchivesChain, which would start synchronization machinery. */
export async function getBucketInfo(config: { url: string; accountName?: string }): Promise<ArchivesConfig> {
    let remote = new ArchivesRemote({ url: config.url, accountName: config.accountName, waitForAccess: false });
    return await remote.getConfig();
}
