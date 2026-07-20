module.allowclient = true;

import { isNode, sort } from "socket-function/src/misc";
import { delay } from "socket-function/src/batching";
import {
    IArchives, RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig,
    ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, STORAGE_WRONG_VALID_WINDOW,
    STORAGE_WRONG_ROUTE, FULL_ROUTE, VARIABLE_SHARD,
} from "../IArchives";
import {
    ROUTING_FILE, getConfigVersion, parseHostedUrl, parseBackblazeUrl,
    normalizeRemoteConfig, normalizeSource, parseRoutingData, serializeRemoteConfig,
    getRoute, routeContains, parseVariableRoute,
} from "./remoteConfig";
import { SocketFunction } from "socket-function/SocketFunction";
import { ArchivesRemote, parseStorageUrl, authenticateStorage } from "./ArchivesRemote";
import { onServerRoutingChanged } from "./storageClientController";
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
// Wrong-valid-window rejections within this distance of a known window boundary are just us racing
// the boundary itself - waiting fixes them, no new config needed
const WRONG_TARGET_BOUNDARY_WINDOW = 30 * 1000;
const WRONG_TARGET_BOUNDARY_RETRY_DELAY = 15 * 1000;
// Otherwise our config is stale; re-fetch it from the server, at most this often (when throttled,
// retry with what we have)
const CONFIG_REFRESH_THROTTLE = 30 * 1000;
// When every source looks down, all of them are re-contacted (routing re-read + connection
// re-attempt) before giving up - at most this often
const AVAILABILITY_RECHECK_THROTTLE = 5 * 1000;

// The direct API IArchives for one source, with no URL-form fallback and no chaining. Used by the
// storage server for its synchronization sources. Denied calls throw immediately (registering the
// access request in the background): the sync loops retry-and-log until access is granted, while
// explicit writes surface the denial (with grant instructions) to the caller instead of hanging.
export function createApiArchives(source: HostedConfig | BackblazeConfig): IArchives {
    if (source.type === "backblaze") {
        return new ArchivesBackblaze({ bucketName: parseBackblazeUrl(source.url).bucketName, public: source.public, immutable: source.immutable, allowedOrigins: source.allowedOrigins });
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

// The window must CONTAIN now (half-open, so a boundary resolves unambiguously). No grace in
// either direction: a boundary is a hard handoff, and a write racing it is simply rejected by the
// server and retried against the newly-valid source.
function configWindowCurrent(config: HostedConfig | BackblazeConfig): boolean {
    let now = Date.now();
    let [start, end] = config.validWindow;
    return start <= now && now < end;
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
    private unsubscribeRoutingPush: (() => void) | undefined;

    constructor(config: RemoteConfig | RemoteConfigBase) {
        this.configured = normalizeRemoteConfig(config);
        this.activeConfig = this.configured;
        // Servers broadcast to their connected clients the moment a routing config changes; the
        // push runs the exact same refresh the poll does, just immediately
        this.unsubscribeRoutingPush = onServerRoutingChanged(() => {
            console.log(`A storage server broadcast a routing config change; refreshing config for ${this.getDebugName()}`);
            void this.refreshActiveConfig().catch((e: Error) => console.error(`Config refresh failed for ${this.getDebugName()}: ${e.stack ?? e}`));
        });
    }

    public getDebugName() {
        let urls = this.activeConfig.sources.map(x => typeof x === "string" && x || (x as HostedConfig | BackblazeConfig).url);
        return `chain ${urls.join(", ")}`;
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
        // EVERY source is contacted for its picture of the routing config (per the spec: the config
        // is duplicated into all of them) - which also establishes our connection to every node up
        // front. Contact is parallel; ADOPTION is deterministic by config order among the sources
        // that answered (the first up source is authoritative).
        let fetches = await Promise.all(configs.map(async sourceConfig => {
            let probe = await SourceWrapper.create(sourceConfig, { background: false });
            let start = Date.now();
            try {
                let data = await probe.read(archives => archives.get(ROUTING_FILE));
                return { probe, sourceConfig, responded: true, latency: Date.now() - start, existing: data && parseRoutingData(data) || undefined, error: "" };
            } catch (e) {
                return { probe, sourceConfig, responded: false, latency: 0, existing: undefined, error: `${sourceConfig.url}: ${(e as Error).stack ?? e}` };
            }
        }));
        try {
            let found = fetches.find(x => x.responded);
            if (!found) {
                throw new Error(`Cannot initialize storage for ${this.getDebugName()}: no source answered. ${fetches.map(x => x.error).join(" | ")}`);
            }
            let existing = found.existing;
            let active = this.configured;
            let needsWrite = true;
            if (existing && getConfigVersion(existing) >= getConfigVersion(this.configured)) {
                if (getConfigVersion(existing) === getConfigVersion(this.configured) && JSON.stringify(existing) !== JSON.stringify(this.configured)) {
                    console.error(`Archives configuration updated without updating the version, for ${found.sourceConfig.url}. Updates will be ignored until you increase the version. Using: ${JSON.stringify(existing)}, ignoring: ${JSON.stringify(this.configured)}`);
                }
                active = existing;
                needsWrite = false;
            }
            if (needsWrite) {
                // We decided to write (ours is newer than the authoritative first-up source's, or
                // no routing exists yet). The write goes to all sources, so it is refused unless
                // our version is strictly greater than EVERY source's stored version (all already
                // fetched above) - a source at (or past) our version means this version number is
                // taken, and writing anyway would leave sources at the same version with different
                // content, each rejecting the other's pushes forever. Down sources are still
                // protected by the server-side version guard when the write eventually reaches them.
                let best: RemoteConfig | undefined;
                let conflictUrl: string | undefined;
                for (let fetch of fetches) {
                    let stored = fetch.existing;
                    if (!stored) continue;
                    if (!best || getConfigVersion(stored) > getConfigVersion(best)) {
                        best = stored;
                    }
                    if (getConfigVersion(stored) === getConfigVersion(this.configured) && JSON.stringify(stored) !== JSON.stringify(this.configured)) {
                        conflictUrl = fetch.sourceConfig.url;
                    }
                }
                if (best && getConfigVersion(best) >= getConfigVersion(this.configured)) {
                    if (conflictUrl && getConfigVersion(best) === getConfigVersion(this.configured)) {
                        console.error(`Archives configuration updated without updating the version, for ${conflictUrl}. Updates will be ignored until you increase the version. Using: ${JSON.stringify(best)}, ignoring: ${JSON.stringify(this.configured)}`);
                    }
                    active = best;
                    needsWrite = false;
                }
            }
            let sources = await this.buildSources(active);
            if (needsWrite) {
                // The update only happens when EVERY source would accept it - a partial update
                // would leave the sources out of sync, and a client without access retrying the
                // write forever would never initialize. Without full access we run on the stored
                // config (when there is one) and log the problem instead.
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
                        // routing, so losing a create race to another client just adopts their
                        // config on the next attempt.
                        // The routing file is NEVER synchronized between storage nodes, so it is
                        // written directly to EVERY node, with one shared write time (the latest
                        // write time wins on each node independently)
                        let routingData = serializeRemoteConfig(this.configured);
                        let routingWriteTime = Date.now();
                        let writtenUrls = new Set<string>();
                        for (let source of sources) {
                            if (writtenUrls.has(source.config.url)) continue;
                            writtenUrls.add(source.config.url);
                        }
                        console.log(`Storage routing config for ${this.getDebugName()} is out of date (stored version ${existing && getConfigVersion(existing) || "none"}, ours ${getConfigVersion(this.configured)}): writing ours to all ${writtenUrls.size} nodes (write time ${new Date(routingWriteTime).toISOString()}): ${[...writtenUrls].join(", ")}`);
                        writtenUrls.clear();
                        for (let source of sources) {
                            if (writtenUrls.has(source.config.url)) continue;
                            writtenUrls.add(source.config.url);
                            await source.write(archives => archives.set(ROUTING_FILE, routingData, { lastModified: routingWriteTime }));
                            console.log(`Wrote storage routing config version ${getConfigVersion(this.configured)} to ${source.config.url}`);
                        }
                    } catch (e) {
                        for (let source of sources) {
                            source.dispose();
                        }
                        throw e;
                    }
                }
            }
            // The server may be MID deploy-takeover: its getConfig returns the in-memory
            // interpretation (window splits pointing at a successor's port), which is never in the
            // routing file. A client connecting during the takeover must start on that
            // interpretation, not discover it minutes later.
            try {
                let probeApi = found.probe.api;
                if (probeApi) {
                    let servedConfig = (await probeApi.getConfig()).remoteConfig;
                    if (servedConfig) {
                        let served = normalizeRemoteConfig(servedConfig);
                        if (JSON.stringify(served) !== JSON.stringify(active) && getConfigVersion(served) >= getConfigVersion(active)) {
                            console.log(`Adopting the server's in-memory routing interpretation at init for ${this.getDebugName()} (deploy takeover in progress)`);
                            active = served;
                            for (let source of sources) {
                                source.dispose();
                            }
                            sources = await this.buildSources(active);
                        }
                    }
                }
            } catch {
                // The raw routing config we already adopted still works
            }
            // The routing fetches double as our first latency measurements: variable-shard picking
            // works immediately, instead of waiting for the first ping pass to land
            for (let source of sources) {
                let fetch = fetches.find(x => x.responded && x.sourceConfig.url === source.config.url);
                if (fetch) {
                    source.seedLatency(fetch.latency);
                }
            }
            this.activeConfig = active;
            this.startConfigPoll();
            return { config: active, sources };
        } finally {
            for (let fetch of fetches) {
                fetch.probe.dispose();
            }
        }
    }

    private async createChainSource(sourceConfig: HostedConfig | BackblazeConfig): Promise<SourceWrapper> {
        let source = await SourceWrapper.create(sourceConfig);
        // A takeover stamp change in a ping means the server's routing interpretation changed
        // (deploy takeover started/ended); refresh so we learn within one ping interval
        source.onServedConfigChanged = () => {
            console.log(`Storage ${source.getDebugName()} advertised a routing change (deploy takeover); refreshing config for ${this.getDebugName()}`);
            void this.refreshActiveConfig().catch((e: Error) => console.error(`Config refresh failed for ${this.getDebugName()}: ${e.stack ?? e}`));
        };
        // Latency (for variable-shard target preference) is tracked from initialization on
        source.startPinging();
        return source;
    }

    private async buildSources(config: RemoteConfig): Promise<SourceWrapper[]> {
        let sources: SourceWrapper[] = [];
        for (let sourceConfig of config.sources.map(normalizeSource)) {
            sources.push(await this.createChainSource(sourceConfig));
        }
        return sources;
    }

    private startConfigPoll(): void {
        if (this.pollTimer || this.disposed) return;
        this.pollTimer = setInterval(() => {
            void this.refreshActiveConfig().catch((e: Error) => {
                console.error(`Checking for a new storage routing config failed for ${this.getDebugName()}: ${e.stack ?? e}`);
            });
        }, CONFIG_POLL_INTERVAL);
        (this.pollTimer as { unref?: () => void }).unref?.();
    }

    // Deduplicates concurrent refreshes (the poll timer and wrong-target write retries share this)
    private configRefreshInFlight: Promise<void> | undefined;
    private refreshActiveConfig(): Promise<void> {
        if (!this.configRefreshInFlight) {
            this.configRefreshInFlight = this.checkForNewConfig().finally(() => {
                this.configRefreshInFlight = undefined;
            });
        }
        return this.configRefreshInFlight;
    }

    // The latest config, as the server INTERPRETS it: getConfig carries in-memory overlays (deploy
    // takeover remaps) that are deliberately never written into the routing file, so it's
    // preferred over reading the raw file. URL-only chains fall back to the raw file.
    private async fetchLatestConfig(state: ChainState): Promise<RemoteConfig | undefined> {
        try {
            let config = await this.run(state, { apiOnly: true }, archives => archives.getConfig());
            if (config.remoteConfig) {
                return normalizeRemoteConfig(config.remoteConfig);
            }
        } catch { }
        let data = await this.run(state, {}, archives => archives.get(ROUTING_FILE));
        if (!data) return undefined;
        return parseRoutingData(data);
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
        let latest = await this.fetchLatestConfig(state);
        if (!latest) return;
        await this.adoptNewConfig(state, latest);
    }

    private async adoptNewConfig(state: ChainState, latest: RemoteConfig): Promise<void> {
        if (JSON.stringify(latest) === JSON.stringify(state.config)) return;
        // Same version but different content is a deploy switchover remap (an in-memory window
        // split pointing at a successor's port), not an actual configuration change
        if (getConfigVersion(latest) === getConfigVersion(state.config)) {
            console.log(`Storage routing reinterpreted at version ${getConfigVersion(latest)} for ${this.getDebugName()} (deploy switchover in progress), rebuilding sources. Sources: ${JSON.stringify(latest.sources)}`);
        } else {
            console.log(`Storage routing config changed for ${this.getDebugName()} (version ${getConfigVersion(state.config)} -> ${getConfigVersion(latest)}), rebuilding sources`);
        }
        // Sources are matched IGNORING the valid window: config updates routinely just move
        // windows (reduce the forever-window, append a new entry after it), and a window-only
        // change must reuse the existing wrapper (connection, pings, latency history) instead of
        // dispose-and-reconnect. The same URL can appear several times differing only by window
        // (deploy window splits), so equal keys pair off in order.
        let strippedKey = (config: HostedConfig | BackblazeConfig) => JSON.stringify({ ...config, validWindow: undefined });
        let oldByConfig = new Map<string, SourceWrapper[]>();
        for (let source of state.sources) {
            let key = strippedKey(source.config);
            let list = oldByConfig.get(key);
            if (!list) {
                list = [];
                oldByConfig.set(key, list);
            }
            list.push(source);
        }
        let sources: SourceWrapper[] = [];
        for (let sourceConfig of latest.sources.map(normalizeSource)) {
            let old = oldByConfig.get(strippedKey(sourceConfig))?.shift();
            if (old) {
                old.updateValidWindow(sourceConfig.validWindow);
                sources.push(old);
            } else {
                sources.push(await this.createChainSource(sourceConfig));
            }
        }
        // In-flight requests still hold the old wrappers and finish fine; dispose just stops any
        // background reconnect/ping loops
        for (let leftovers of oldByConfig.values()) {
            for (let leftover of leftovers) {
                leftover.dispose();
            }
        }
        this.activeConfig = latest;
        this.statePromise = Promise.resolve({ config: latest, sources });
    }

    // When every source looks down, the routing config is re-read from EVERY source - which both
    // re-attempts their connections (our liveness re-check) and discovers a routing update we may
    // have missed (adopting it re-initializes the source list). Concurrent callers share one pass.
    private lastAvailabilityRecheck = 0;
    private availabilityRecheckInFlight: Promise<void> | undefined;
    private recheckAvailability(): Promise<void> {
        if (this.availabilityRecheckInFlight) return this.availabilityRecheckInFlight;
        if (Date.now() - this.lastAvailabilityRecheck < AVAILABILITY_RECHECK_THROTTLE) return Promise.resolve();
        this.lastAvailabilityRecheck = Date.now();
        this.availabilityRecheckInFlight = this.recheckAvailabilityNow().finally(() => {
            this.availabilityRecheckInFlight = undefined;
        });
        return this.availabilityRecheckInFlight;
    }
    private async recheckAvailabilityNow(): Promise<void> {
        if (this.disposed || !this.statePromise) return;
        let state: ChainState;
        try {
            state = await this.statePromise;
        } catch {
            // Init is failing; its own retry loop handles that
            return;
        }
        console.log(`Every storage source failed for ${this.getDebugName()}; re-contacting all ${state.sources.length} sources (routing re-read + connection re-attempt)`);
        let results = await Promise.all(state.sources.map(async source => {
            try {
                let data = await source.read(archives => archives.get(ROUTING_FILE));
                return data && parseRoutingData(data) || undefined;
            } catch {
                return undefined;
            }
        }));
        let latest = results.find(x => x);
        if (!latest) return;
        await this.adoptNewConfig(state, latest);
    }

    // Runs a request against the first available source (that covers the key's route, when one is
    // given), moving to the next one ONLY when the source's WebSocket is down (checked directly -
    // never by inspecting the error, which is arbitrary data). An error from a connected source is
    // an application error and throws as-is. A down source gets its background reconnect kicked.
    private async run<T>(state: ChainState, config: { apiOnly?: boolean; write?: boolean; route?: number }, run: (archives: IArchives) => Promise<T>): Promise<T> {
        if (config.write) {
            return await this.runWrite(config.route, run);
        }
        let recheckedAvailability = false;
        while (true) {
            let errors: string[] = [];
            for (let source of state.sources) {
                if (config.route !== undefined && !routeContains(source.config.route, config.route)) continue;
                if (!configWindowCurrent(source.config)) continue;
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
            // Every source failed: re-contact everything (routing re-read + connection re-attempt,
            // possibly adopting a routing update) and try once more before giving up
            if (!recheckedAvailability) {
                recheckedAvailability = true;
                await this.recheckAvailability();
                state = await this.getState();
                continue;
            }
            throw new Error(`All sources failed for ${this.getDebugName()}${config.route !== undefined && ` (route ${config.route})` || ""}: ${errors.join(" | ") || "no sources available"}`);
        }
    }

    // Writes are consistent: they go to the first currently-valid source covering the key's route
    // and NEVER fail over to another node - a client wrongly deciding nodes are down must not
    // scatter its writes across the chain. (Reads fail over freely above: sources are synchronized
    // copies, so reading from any of them is safe.) The one retry is for a window boundary passing
    // (or a route disagreement) mid-write, which re-resolves the target rather than falling back.
    private async runWrite<T>(route: number | undefined, run: (archives: IArchives) => Promise<T>): Promise<T> {
        let retriedWrongWindow = false;
        let retriedWrongRoute = false;
        let recheckedAvailability = false;
        while (true) {
            let state = await this.getState();
            let target = state.sources.find(x => configAcceptsWrites(x.config) && (route === undefined || routeContains(x.config.route, route)));
            if (!target) {
                // Before giving up, re-contact every source once (routing re-read + connection
                // re-attempt, possibly adopting a routing update that fixes the target)
                if (!recheckedAvailability) {
                    recheckedAvailability = true;
                    await this.recheckAvailability();
                    continue;
                }
                throw new Error(`No source accepts writes for ${this.getDebugName()}${route !== undefined && ` (route ${route})` || ""} (every source is outside its valid window or outside the key's route)`);
            }
            try {
                return await target.write(run);
            } catch (e) {
                let message = String((e as Error).stack ?? e);
                if (message.includes(STORAGE_WRONG_VALID_WINDOW) && !retriedWrongWindow) {
                    retriedWrongWindow = true;
                    await this.prepareWrongTargetRetry(state, "window");
                    continue;
                }
                if (message.includes(STORAGE_WRONG_ROUTE) && !retriedWrongRoute) {
                    retriedWrongRoute = true;
                    await this.prepareWrongTargetRetry(state, "route");
                    continue;
                }
                // The connection died during (or before) the request. One full re-contact pass,
                // then one retry - still the same consistent target, never a different node.
                if (!target.isConnected()) {
                    target.noteFailure();
                    if (!recheckedAvailability) {
                        recheckedAvailability = true;
                        await this.recheckAvailability();
                        continue;
                    }
                }
                throw e;
            }
        }
    }

    private lastConfigRefresh = 0;
    // A wrong-target rejection means either we raced a window boundary (time fixes it) or our
    // config is stale - e.g. a deploy-takeover remap that only exists in the server's memory
    private async prepareWrongTargetRetry(state: ChainState, kind: "window" | "route"): Promise<void> {
        if (kind === "window") {
            let now = Date.now();
            let nearBoundary = state.sources.some(source => source.config.validWindow.some(t => t > 0 && t < Number.MAX_SAFE_INTEGER && Math.abs(t - now) <= WRONG_TARGET_BOUNDARY_WINDOW));
            if (nearBoundary) {
                console.log(`Write rejected by ${this.getDebugName()}: raced a valid window boundary; waiting ${WRONG_TARGET_BOUNDARY_RETRY_DELAY / 1000}s and retrying`);
                await delay(WRONG_TARGET_BOUNDARY_RETRY_DELAY);
                return;
            }
        }
        if (Date.now() - this.lastConfigRefresh < CONFIG_REFRESH_THROTTLE) return;
        this.lastConfigRefresh = Date.now();
        console.log(`Write rejected by ${this.getDebugName()} (wrong ${kind}): our config is stale (likely a deploy switchover); refreshing it and retrying`);
        await this.refreshActiveConfig();
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
    private selectCoveringSources(state: ChainState, excluded: Set<SourceWrapper>): SourceWrapper[] {
        let candidates = state.sources.filter(x => configWindowCurrent(x.config) && x.api && !excluded.has(x));
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

    // Fans one call out over a covering set of shards. Sources are never pre-filtered by
    // connectivity - the request is attempted, and a failure with the socket down afterwards
    // excludes that source and re-selects the covering set (an error from a live source throws).
    private async runOnCovering<T>(run: (archives: IArchives) => Promise<T>): Promise<T[]> {
        let state = await this.getState();
        let excluded = new Set<SourceWrapper>();
        while (true) {
            let covering = this.selectCoveringSources(state, excluded);
            let results = await Promise.all(covering.map(async source => {
                let api = source.api;
                if (!api) {
                    throw new Error(`${source.config.url} has URL-only access, which cannot serve this operation`);
                }
                try {
                    return { value: await run(api) };
                } catch (e) {
                    if (source.isConnected()) throw e;
                    source.noteFailure();
                    excluded.add(source);
                    return undefined;
                }
            }));
            if (results.every(x => x)) {
                return results.map(x => (x as { value: T }).value);
            }
        }
    }

    public async find(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<string[]> {
        return (await this.findInfo(prefix, config)).map(x => x.path);
    }
    public async findInfo(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        let results = await this.runOnCovering(archives => archives.findInfo(prefix, config));
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
        let results = await this.runOnCovering(async archives => {
            if (!archives.getChangesAfter) {
                throw new Error(`${archives.getDebugName()} does not support getChangesAfter`);
            }
            return await archives.getChangesAfter(time);
        });
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
        let statuses = await this.runOnCovering(async archives => {
            if (!archives.getSyncStatus) {
                throw new Error(`${archives.getDebugName()} does not support getSyncStatus`);
            }
            return await archives.getSyncStatus();
        });
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

    /** Returns the full key written. Plain keys come back unchanged; keys containing VARIABLE_SHARD
     *  are automatically materialized (a shard value is picked and embedded, see setVariableShard)
     *  and the caller needs the returned key to ever read the value back. */
    public async set(fileName: string, data: Buffer, config?: { lastModified?: number }): Promise<string> {
        if (fileName === ROUTING_FILE) {
            return await this.setRoutingConfig(data, config);
        }
        if (fileName.includes(VARIABLE_SHARD) && parseVariableRoute(fileName) === undefined) {
            return await this.setVariableShard(fileName, data, config);
        }
        await this.request({ write: true, route: getRoute(fileName) }, archives => archives.set(fileName, data, config));
        return fileName;
    }

    // The routing config is NEVER synchronized between nodes, so a chain-level write of it goes
    // directly to EVERY node - first-valid-source routing would leave every other node on the old
    // config forever. One shared write time, so each node resolves latest-write-time-wins
    // identically. Afterwards we immediately run the same refresh the config poll uses: the
    // update must apply to us now, not whenever the poll would have noticed.
    private async setRoutingConfig(data: Buffer, config?: { lastModified?: number }): Promise<string> {
        let state = await this.getState();
        // Parse first, so a malformed config fails before any node stores it
        let incoming = parseRoutingData(data);
        let writeTime = config?.lastModified || Date.now();
        let written: string[] = [];
        let errors: string[] = [];
        let seen = new Set<string>();
        console.log(`Writing storage routing config version ${getConfigVersion(incoming)} for ${this.getDebugName()} to every node (write time ${new Date(writeTime).toISOString()})`);
        for (let source of state.sources) {
            if (seen.has(source.config.url)) continue;
            seen.add(source.config.url);
            try {
                await source.write(archives => archives.set(ROUTING_FILE, data, { lastModified: writeTime }));
                written.push(source.config.url);
                console.log(`Wrote storage routing config version ${getConfigVersion(incoming)} to ${source.config.url}`);
            } catch (e) {
                errors.push(`${source.config.url}: ${(e as Error).stack ?? e}`);
            }
        }
        await this.refreshActiveConfig();
        if (errors.length) {
            throw new Error(`Storage routing config write for ${this.getDebugName()} failed on ${errors.length} of ${seen.size} nodes (succeeded on: ${written.join(", ") || "none"}): ${errors.join(" | ")}`);
        }
        return ROUTING_FILE;
    }
    public async del(fileName: string): Promise<void> {
        await this.request({ write: true, route: getRoute(fileName) }, archives => archives.del(fileName));
    }

    // Writes a bare variable-shard key: picks the lowest-latency up write shard, materializes the
    // key with a random value inside that shard's route, writes it, and returns the FULL key
    // actually written. Unlike normal writes this CAN move to another shard when the preferred one
    // is down (error + socket down, same rule as reads) - each shard receives a different key, so
    // write consistency is preserved.
    private async setVariableShard(key: string, data: Buffer, config?: { lastModified?: number }): Promise<string> {
        let recheckedAvailability = false;
        while (true) {
            let state = await this.getState();
            // Per-shard write consistency still holds: within a route, only the FIRST source may
            // take writes - latency only picks WHICH shard the key materializes into
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
                let [start, end] = target.config.route || FULL_ROUTE;
                let fullKey = key.replace(VARIABLE_SHARD, VARIABLE_SHARD + "_" + (start + Math.random() * (end - start)));
                try {
                    await target.write(archives => archives.set(fullKey, data, config));
                    return fullKey;
                } catch (e) {
                    // NOTE: If we run into cases when transport level errors happen, but we are still connected, then we might want to add additional checking here, additional errors in which we will retry the other targets. However, ideally, checking if the WebSocket connection is still connected will handle all those cases. Distinguishing between application errors (which we can't retry) and transport errors.
                    if (target.isConnected()) throw e;
                    target.noteFailure();
                    console.log(`Variable-shard write target ${target.getDebugName()} is down; moving to the next-lowest-latency shard`);
                    errors.push(String((e as Error).stack ?? e));
                }
            }
            // Every shard failed: re-contact everything and try once more before giving up
            if (!recheckedAvailability) {
                recheckedAvailability = true;
                await this.recheckAvailability();
                continue;
            }
            throw new Error(`Every variable-shard write target failed for ${this.getDebugName()}: ${errors.join(" | ") || "no sources accept writes"}`);
        }
    }

    public async setLargeFile(config: { path: string; getNextData(): Promise<Buffer | undefined> }): Promise<void> {
        if (config.path.includes(VARIABLE_SHARD) && parseVariableRoute(config.path) === undefined) {
            throw new Error(`setLargeFile does not support VARIABLE_SHARD keys (there is no way to return the materialized key); write the file with set, or materialize the key yourself. Key: ${JSON.stringify(config.path)}`);
        }
        let route = getRoute(config.path);
        let recheckedAvailability = false;
        while (true) {
            let state = await this.getState();
            // Same consistency rule as runWrite: the first currently-valid source for the route, or nothing
            let target = state.sources.find(x => configAcceptsWrites(x.config) && routeContains(x.config.route, route));
            if (!target) {
                if (!recheckedAvailability) {
                    recheckedAvailability = true;
                    await this.recheckAvailability();
                    continue;
                }
                throw new Error(`No source accepts writes for setLargeFile on ${this.getDebugName()} (route ${route})`);
            }
            try {
                await target.write(archives => archives.setLargeFile(config));
                return;
            } catch (e) {
                // The data stream cannot be rewound, so a mid-upload disconnect cannot be retried
                if (!target.isConnected()) {
                    target.noteFailure();
                }
                throw e;
            }
        }
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
        this.unsubscribeRoutingPush?.();
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
