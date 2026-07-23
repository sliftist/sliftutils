import { isNode, sort, watchSlowPromise } from "socket-function/src/misc";
import { delay } from "socket-function/src/batching";
import {
    IArchives, RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig,
    ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, ChangesAfterConfig, GetConfig, GetInfoConfig, SetConfig, STORAGE_WRONG_VALID_WINDOW,
    STORAGE_WRONG_ROUTE, FULL_ROUTE, VARIABLE_SHARD,
} from "../IArchives";
import {
    ROUTING_FILE, getConfigVersion, parseHostedUrl, parseBackblazeUrl,
    normalizeRemoteConfig, normalizeSource, serializeRemoteConfig,
    getRoute, routeContains, parseVariableRoute, getBucketBaseUrl, buildFileUrl,
} from "./remoteConfig";
import { ArchivesUrl } from "./ArchivesUrl";
import { resolveIntermediateSources } from "./intermediateSources";
import { SocketFunction } from "socket-function/SocketFunction";
import { ArchivesRemote, parseStorageUrl, authenticateStorage } from "./ArchivesRemote";
import { onServerRoutingChanged } from "./storageClientController";
import { ArchivesBackblaze } from "../backblaze";
import { getLocalArchives, isOwnAddress, ServerBucketInfo, ActiveBucketInfo } from "./storageServerState";
import { RemoteStorageController, STORAGE_NOT_AUTHENTICATED } from "./storageController";
import { SourceWrapper, RETRY_START_DELAY, RETRY_MAX_DELAY, RETRY_GROWTH } from "./sourceWrapper";

const CONFIG_POLL_INTERVAL = 5 * 60 * 1000;
const WRONG_TARGET_BOUNDARY_WINDOW = 30 * 1000;
const WRONG_TARGET_BOUNDARY_RETRY_DELAY = 15 * 1000;
const CONFIG_REFRESH_THROTTLE = 30 * 1000;
const AVAILABILITY_RECHECK_THROTTLE = 5 * 1000;
const PRIMARY_RETRY_TIMEOUT = 30 * 1000;
const PRIMARY_RETRY_DELAY = 2 * 1000;
// Smart timeouts: an attempt gets this long to produce anything before we probe getInfo for the file's size (and the probe itself gets the same window)
const SMART_TIMEOUT_PROBE = 10 * 1000;
// Very generous assumed transfer rates - the resulting deadline exists to catch stuck sources, not slow ones
const SMART_TIMEOUT_DOWNLOAD_BYTES_PER_SECOND = 1024 * 1024;
const SMART_TIMEOUT_UPLOAD_BYTES_PER_SECOND = 512 * 1024;
// Marker in smart-timeout errors, so the read loop can log them and continue with the other sources (a connected source's other errors still throw)
const SMART_TIMEOUT_MARKER = "ARCHIVES_SMART_TIMEOUT_c41a9d";

// Sizes a generous per-attempt deadline. Get-style calls pass path: the size is only fetched (via getInfo) when the call turns out to be slow. Set-style calls pass uploadBytes, which they already know.
type SmartTimeout = {
    path?: string;
    uploadBytes?: number;
};

/** The address, port, account, and bucket name a bucket routing URL addresses. Throws when the URL isn't a hosted bucket routing URL (https://host:port/file/<account>/<bucketName>/storage/storagerouting.json). */
export { parseHostedUrl, parseBackblazeUrl, getBucketBaseUrl } from "./remoteConfig";

export function createApiArchives(source: HostedConfig | BackblazeConfig): IArchives {
    if (source.type === "backblaze") {
        return new ArchivesBackblaze({ bucketName: parseBackblazeUrl(source.url).bucketName, public: source.public, immutable: source.immutable, allowedOrigins: source.allowedOrigins });
    }
    let parsed = parseHostedUrl(source.url);
    if (isNode() && isOwnAddress(parsed.address, parsed.port)) {
        return getLocalArchives(parsed.account, parsed.bucketName);
    }
    return new ArchivesRemote({ url: source.url, waitForAccess: false });
}

type ChainState = {
    config: RemoteConfig;
    sources: SourceWrapper[];
};

export type ArchivesChainOptions = {
    /** Outside of node we default to read-only downloads over the public URLs (no API connection) when the config has public sources. Set this to connect to the API anyway - needed for writing, listing, and any other operation the plain URL form cannot serve. */
    directConnect?: boolean;
};

function configWindowCurrent(config: HostedConfig | BackblazeConfig): boolean {
    let now = Date.now();
    let [start, end] = config.validWindow;
    return start <= now && now < end;
}

function configAcceptsWrites(config: HostedConfig | BackblazeConfig): boolean {
    return configWindowCurrent(config);
}

function materializeShardKey(key: string, target: SourceWrapper): string {
    let [start, end] = target.config.route || FULL_ROUTE;
    return key.replace(VARIABLE_SHARD, VARIABLE_SHARD + "_" + (start + Math.random() * (end - start)));
}

/** The fewest sources whose routes span the whole key space, or undefined when they leave a gap. */
function coverRoutes(candidates: SourceWrapper[]): SourceWrapper[] | undefined {
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
        if (!best) return undefined;
        chosen.push(best);
        covered = bestEnd;
    }
    return chosen;
}

/** READS ONLY. Drops sources that recently failed while disconnected - unless that would leave nothing, in which case a down source is still better than no source, and we retry it immediately. Never applies to writes (or noFallbacks reads of the write target): the write node is strictly the FIRST source matching the route and valid window, regardless of connectivity - a client's flaky view of the network must never scatter writes across the chain (spec: client writes are consistent, client reads are redundant). */
function preferUsable(sources: SourceWrapper[]): SourceWrapper[] {
    let usable = sources.filter(x => !x.isOnCooldown());
    return usable.length && usable || sources;
}

export class ArchivesChain implements IArchives {
    private configured: RemoteConfig;
    private activeConfig: RemoteConfig;
    private statePromise: Promise<ChainState> | undefined;
    // The resolved state, for synchronous access (getGetURLs) - always the newest adopted config, where statePromise may briefly lag during a rebuild
    private latestState: ChainState | undefined;
    private initRetryDelay = RETRY_START_DELAY;
    private initRetryTimer: ReturnType<typeof setTimeout> | undefined;
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private disposed = false;
    private unsubscribeRoutingPush: (() => void) | undefined;

    constructor(config: RemoteConfig | RemoteConfigBase, private options?: ArchivesChainOptions) {
        this.configured = normalizeRemoteConfig(config);
        this.activeConfig = this.configured;
        this.unsubscribeRoutingPush = onServerRoutingChanged(() => {
            void this.refreshActiveConfig().catch((e: Error) => console.error(`Config refresh failed for ${this.getDebugName()}: ${e.stack ?? e}`));
        });
    }

    public getDebugName() {
        let urls = this.activeConfig.sources.map(x => typeof x === "string" && x || (x as HostedConfig | BackblazeConfig).url);
        return `chain ${urls.join(", ")}`;
    }

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
        let readOnly = this.isReadOnly(this.configured);
        let fetches = await Promise.all(configs.map(async sourceConfig => {
            let probe = await SourceWrapper.create(sourceConfig, { background: false, readOnly });
            let start = Date.now();
            try {
                let existing = await probe.readRoutingConfig();
                return { probe, sourceConfig, responded: true, latency: Date.now() - start, existing, error: "" };
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
            for (let source of sources) {
                let fetch = fetches.find(x => x.responded && x.sourceConfig.url === source.config.url);
                if (fetch) {
                    source.seedLatency(fetch.latency);
                }
            }
            this.activeConfig = active;
            this.startConfigPoll();
            let state: ChainState = { config: active, sources };
            this.latestState = state;
            return state;
        } finally {
            for (let fetch of fetches) {
                fetch.probe.dispose();
            }
        }
    }

    /** Clientside, a config with public sources is served entirely over plain URL downloads - no API connection, no access grant, and no writing. directConnect opts out of that. */
    private isReadOnly(config: RemoteConfig): boolean {
        if (this.options?.directConnect || isNode()) return false;
        return config.sources.map(normalizeSource).some(x => x.public);
    }

    private async createChainSource(sourceConfig: HostedConfig | BackblazeConfig, readOnly: boolean): Promise<SourceWrapper> {
        let source = await SourceWrapper.create(sourceConfig, { readOnly });
        source.startPinging();
        return source;
    }

    private async buildSources(config: RemoteConfig): Promise<SourceWrapper[]> {
        let readOnly = this.isReadOnly(config);
        let sources: SourceWrapper[] = [];
        for (let sourceConfig of config.sources.map(normalizeSource)) {
            sources.push(await this.createChainSource(sourceConfig, readOnly));
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
    private async fetchLatestConfig(state: ChainState): Promise<RemoteConfig | undefined> {
        let errors: string[] = [];
        for (let source of state.sources) {
            try {
                let latest = await source.readRoutingConfig();
                if (latest) return normalizeRemoteConfig(latest);
            } catch (e) {
                errors.push(`${source.config.url}: ${(e as Error).stack ?? e}`);
            }
        }
        if (errors.length === state.sources.length) {
            throw new Error(`No storage source could give us the routing config for ${this.getDebugName()}: ${errors.join(" | ")}`);
        }
        return undefined;
    }

    private async checkForNewConfig(): Promise<void> {
        if (this.disposed || !this.statePromise) return;
        let state: ChainState;
        try {
            state = await this.statePromise;
        } catch {
            return;
        }
        let latest = await this.fetchLatestConfig(state);
        if (!latest) return;
        await this.adoptNewConfig(state, latest);
    }

    private async adoptNewConfig(state: ChainState, latest: RemoteConfig): Promise<void> {
        if (JSON.stringify(latest) === JSON.stringify(state.config)) return;
        let received = new Date().toISOString();
        let onlyIntermediatesChanged = JSON.stringify(resolveIntermediateSources(latest)) === JSON.stringify(resolveIntermediateSources(state.config));
        if (onlyIntermediatesChanged) {
            console.log(`Storage routing switchover windows changed (version ${getConfigVersion(state.config)} -> ${getConfigVersion(latest)}), received ${received}, rebuilding sources. New config: ${JSON.stringify(latest)}`);
        } else {
            console.log(`Storage routing config changed (version ${getConfigVersion(state.config)} -> ${getConfigVersion(latest)}), received ${received}, rebuilding sources. New config: ${JSON.stringify(latest)}`);
        }
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
        let readOnly = this.isReadOnly(latest);
        let sources: SourceWrapper[] = [];
        for (let sourceConfig of latest.sources.map(normalizeSource)) {
            let old = oldByConfig.get(strippedKey(sourceConfig))?.shift();
            if (old) {
                old.updateValidWindow(sourceConfig.validWindow);
                sources.push(old);
            } else {
                sources.push(await this.createChainSource(sourceConfig, readOnly));
            }
        }
        for (let leftovers of oldByConfig.values()) {
            for (let leftover of leftovers) {
                leftover.dispose();
            }
        }
        this.activeConfig = latest;
        let newState: ChainState = { config: latest, sources };
        this.latestState = newState;
        this.statePromise = Promise.resolve(newState);
    }

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
            return;
        }
        console.log(`Every storage source failed for ${this.getDebugName()}; re-contacting all ${state.sources.length} sources (routing re-read + connection re-attempt)`);
        let results = await Promise.all(state.sources.map(async source => {
            try {
                return await source.readRoutingConfig();
            } catch {
                return undefined;
            }
        }));
        let latest = results.find(x => x);
        if (!latest) return;
        await this.adoptNewConfig(state, latest);
    }

    private async run<T>(state: ChainState, config: { apiOnly?: boolean; write?: boolean; route?: number; noFallbacks?: boolean; fast?: boolean; timeout?: SmartTimeout }, run: (archives: IArchives, sourceUrl: string) => Promise<T>): Promise<T> {
        if (config.fast && config.noFallbacks) {
            throw new Error(`fast and noFallbacks are mutually exclusive for ${this.getDebugName()}: noFallbacks only considers one source (the write node), so there is no order to speed up`);
        }
        if (config.write || config.noFallbacks) {
            return await this.runPrimary(config, run);
        }
        let recheckedAvailability = false;
        while (true) {
            let errors: string[] = [];
            let candidates = state.sources.filter(source =>
                (config.route === undefined || routeContains(source.config.route, config.route))
                && configWindowCurrent(source.config)
            );
            let ordered = preferUsable(candidates);
            if (config.fast) {
                ordered = [...ordered];
                sort(ordered, x => x.getLatency());
            }
            for (let source of ordered) {
                try {
                    if (config.apiOnly) {
                        let api = source.api;
                        if (!api) {
                            errors.push(`${source.config.url} has URL-only access, which cannot serve this operation`);
                            continue;
                        }
                        return await run(api, source.config.url);
                    }
                    return await this.applySmartTimeout(config.timeout, source, () => source.read(archives => run(archives, source.config.url)));
                } catch (e) {
                    let message = String((e as Error).stack ?? e);
                    if (message.includes(SMART_TIMEOUT_MARKER)) {
                        console.error(`Source timed out for ${this.getDebugName()}, continuing with the next source: ${message}`);
                        errors.push(message);
                        continue;
                    }
                    if (source.isConnected()) throw e;
                    source.noteFailure();
                    errors.push(message);
                }
            }
            if (!recheckedAvailability) {
                recheckedAvailability = true;
                await this.recheckAvailability();
                state = await this.getState();
                continue;
            }
            throw new Error(`All sources failed for ${this.getDebugName()}${config.route !== undefined && ` (route ${config.route})` || ""}: ${errors.join(" | ") || "no sources available"}`);
        }
    }

    // Writes and noFallbacks reads are the same case: take the authoritative node - strictly the first source matching the route and valid window, whether it is up or down - and use it, never falling back to another node. It's important that writing always accesses the same node everywhere, even if that node is down - otherwise we're just writing into the void, and who knows if the writes will even be accepted, or clobbered, or what; and noFallbacks reads want the same node precisely because it is the one writes target. A slow call is almost always better than throwing, so a failing primary is retried (the SAME node, re-resolved each attempt since a config refresh can change which source is primary) until the deadline, then throws.
    private async runPrimary<T>(config: { write?: boolean; route?: number; timeout?: SmartTimeout }, run: (archives: IArchives, sourceUrl: string) => Promise<T>): Promise<T> {
        let retriedWrongWindow = false;
        let retriedWrongRoute = false;
        let deadline = Date.now() + PRIMARY_RETRY_TIMEOUT;
        let attempt = 0;
        while (true) {
            attempt++;
            let attemptStart = Date.now();
            let state = await this.getState();
            let target = state.sources.find(x => configAcceptsWrites(x.config) && (config.route === undefined || routeContains(x.config.route, config.route)));
            try {
                if (!target) {
                    throw new Error(`No source is the ${config.write && "write target" || "primary read source"} for ${this.getDebugName()}${config.route !== undefined && ` (route ${config.route})` || ""} (every source is outside its valid window or outside the key's route)`);
                }
                const primary = target;
                return await this.applySmartTimeout(config.timeout, primary, () => {
                    if (config.write) return primary.write(archives => run(archives, primary.config.url));
                    return primary.read(archives => run(archives, primary.config.url));
                });
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
                if (target && !target.isConnected()) target.noteFailure();
                if (!config.write && target && (attempt === 1 || attempt % 3 === 0)) {
                    // The reason we try the HTTP request: httpsRequest has better DNS retrying capabilities than our WebSocket server (we have more control over it), so just using it can fix some DNS issues, which can propagate to fix the WebSocket connection. It is still the primary source's own data, so the no-fallback semantics hold - and ArchivesUrl has no setup cost, so making one on the spot is fine.
                    try {
                        return await run(target.url || new ArchivesUrl(getBucketBaseUrl(target.config.url)), target.config.url);
                    } catch {
                        // Best-effort: the primary's error (thrown at the deadline) is the real one
                    }
                }
                if (Date.now() >= deadline) throw e;
            }
            // At most one attempt per interval, in case the failure is fast
            await delay(Math.max(0, attemptStart + PRIMARY_RETRY_DELAY - Date.now()));
            await this.recheckAvailability();
        }
    }

    /** Races call against a size-based deadline. Uploads know their size upfront; gets are given SMART_TIMEOUT_PROBE to produce anything, and only then is the file's info fetched (from the same source, itself time-limited) to size the deadline - measured from the call's start, so a source that was slow before the probe doesn't get the full allowance again. Timed-out calls keep running in the background (they cannot be cancelled) but their eventual result is ignored. */
    private async applySmartTimeout<T>(timeout: SmartTimeout | undefined, source: SourceWrapper, call: () => Promise<T>): Promise<T> {
        if (!timeout) return await call();
        let start = Date.now();
        let callPromise = call();
        // An abandoned call must not surface an unhandled rejection when it eventually fails
        let abandon = () => void callPromise.then(() => { }, () => { });
        if (timeout.uploadBytes !== undefined) {
            // A flat base plus the predicted transfer time, so tiny uploads still get the full base window
            let allowed = SMART_TIMEOUT_PROBE + timeout.uploadBytes / SMART_TIMEOUT_UPLOAD_BYTES_PER_SECOND * 1000;
            let result = await Promise.race([callPromise.then(value => ({ value })), delay(allowed).then(() => undefined)]);
            if (result) return result.value;
            abandon();
            throw new Error(`${SMART_TIMEOUT_MARKER} Upload of ${timeout.uploadBytes} bytes to ${source.getDebugName()} timed out after ${Date.now() - start}ms (allowed ${Math.round(allowed)}ms: ${SMART_TIMEOUT_PROBE}ms base plus transfer at an assumed ${SMART_TIMEOUT_UPLOAD_BYTES_PER_SECOND} bytes/s)`);
        }
        const path = timeout.path;
        if (path === undefined) return await callPromise;
        let first = await Promise.race([callPromise.then(value => ({ value })), delay(SMART_TIMEOUT_PROBE).then(() => undefined)]);
        if (first) return first.value;
        let probeError: string | undefined;
        let info: { size: number } | undefined;
        try {
            info = await Promise.race([
                source.read(archives => archives.getInfo(path)).then(x => ({ size: x && x.size || 0 })),
                delay(SMART_TIMEOUT_PROBE).then(() => undefined),
            ]);
        } catch (e) {
            probeError = String((e as Error).stack ?? e);
        }
        if (!info) {
            abandon();
            throw new Error(`${SMART_TIMEOUT_MARKER} Read of ${JSON.stringify(path)} from ${source.getDebugName()} timed out: no result after ${Date.now() - start}ms, and getInfo ${probeError && `failed (${probeError})` || `could not answer within ${SMART_TIMEOUT_PROBE}ms either`}`);
        }
        let allowed = Math.max(SMART_TIMEOUT_PROBE, info.size / SMART_TIMEOUT_DOWNLOAD_BYTES_PER_SECOND * 1000);
        let remaining = start + allowed - Date.now();
        if (remaining > 0) {
            let second = await Promise.race([callPromise.then(value => ({ value })), delay(remaining).then(() => undefined)]);
            if (second) return second.value;
        }
        abandon();
        throw new Error(`${SMART_TIMEOUT_MARKER} Read of ${JSON.stringify(path)} (${info.size} bytes) from ${source.getDebugName()} timed out after ${Date.now() - start}ms (allowed ${Math.round(allowed)}ms from the call's start, at an assumed ${SMART_TIMEOUT_DOWNLOAD_BYTES_PER_SECOND} bytes/s)`);
    }

    private lastConfigRefresh = 0;
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

    private async request<T>(config: { apiOnly?: boolean; write?: boolean; route?: number; noFallbacks?: boolean; fast?: boolean; timeout?: SmartTimeout }, run: (archives: IArchives, sourceUrl: string) => Promise<T>): Promise<T> {
        let state = await this.getState();
        return await this.run(state, config, run);
    }

    public async waitingForAccess(): Promise<{ link: string; machineId: string; ip: string } | undefined> {
        let state = await this.getState();
        for (let source of state.sources) {
            // A source whose window has passed is never read or written again, so its access state is irrelevant - and asking a dead intermediate would just hang or throw. Future windows DO matter: access should be granted before their window starts.
            if (source.config.validWindow[1] <= Date.now()) continue;
            if (source.api instanceof ArchivesRemote) {
                let waiting = await source.api.waitingForAccess();
                if (waiting) return waiting;
            }
        }
        return undefined;
    }

    public async get(fileName: string, config?: GetConfig): Promise<Buffer | undefined> {
        let result = await this.get2(fileName, config);
        return result && result.data || undefined;
    }
    /** get2, but trying sources in latency order (fastest first) instead of config order. While this is much faster, it might miss immediate writes: the write node is no longer tried first, so a lagging replica may answer with a slightly older value. Exclusive with noFallbacks (which only considers one source - the write node - so there is no order to speed up); passing both throws. */
    public async getFast(fileName: string, config?: GetConfig): Promise<{ data: Buffer; writeTime: number; size: number; url: string } | { data?: undefined; writeTime?: undefined; size?: undefined; url: string }> {
        return await this.request({ route: getRoute(fileName), noFallbacks: config?.noFallbacks, fast: true, timeout: { path: fileName } }, async (archives, url) => {
            let result = await archives.get2(fileName, config);
            return result && result.data && { data: result.data, writeTime: result.writeTime, size: result.size, url } || { url };
        });
    }
    /** Always resolves with a url - the authority that answered. A value that doesn't exist is still an answer FROM a server, so it comes back as { url } with no data (never plain undefined); errors from every source throw instead. */
    public async get2(fileName: string, config?: GetConfig): Promise<{ data: Buffer; writeTime: number; size: number; url: string } | { data?: undefined; writeTime?: undefined; size?: undefined; url: string }> {
        return await this.request({ route: getRoute(fileName), noFallbacks: config?.noFallbacks, timeout: { path: fileName } }, async (archives, url) => {
            let result = await archives.get2(fileName, config);
            return result && result.data && { data: result.data, writeTime: result.writeTime, size: result.size, url } || { url };
        });
    }
    public async getInfo(fileName: string, config?: GetInfoConfig): Promise<{ writeTime: number; size: number; url: string } | undefined> {
        return await this.request({ route: getRoute(fileName) }, async (archives, url) => {
            let result = await archives.getInfo(fileName, config);
            return result && { ...result, url } || undefined;
        });
    }

    private selectCoveringSources(state: ChainState, excluded: Set<SourceWrapper>): SourceWrapper[] {
        let candidates = state.sources.filter(x => configWindowCurrent(x.config) && x.api && !excluded.has(x));
        // Unlike the single-source paths, dropping a cooled-down source can leave a route gap - so the cooled-down set only comes back as a whole, when the healthy sources cannot cover everything on their own
        let chosen = coverRoutes(candidates.filter(x => !x.isOnCooldown())) || coverRoutes(candidates);
        if (!chosen) {
            throw new Error(`Cannot cover the full route space for ${this.getDebugName()}: the available sources leave a gap (some shards are down or URL-only)`);
        }
        return chosen;
    }

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
    public async getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]> {
        let results = await this.runOnCovering(archives => archives.getChangesAfter2(config));
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
    public async hasWriteAccess(): Promise<boolean> {
        let state = await this.getState();
        for (let source of state.sources) {
            if (!configAcceptsWrites(source.config)) continue;
            if (!await source.hasWriteAccess()) return false;
        }
        return true;
    }

    public async set(fileName: string, data: Buffer, config?: SetConfig): Promise<string> {
        if (fileName === ROUTING_FILE) {
            return await this.setRoutingConfig(data, config);
        }
        if (fileName.includes(VARIABLE_SHARD) && parseVariableRoute(fileName) === undefined) {
            return await this.setVariableShard(fileName, data, config);
        }
        await this.request({ write: true, route: getRoute(fileName), timeout: { uploadBytes: data.length } }, archives => archives.set(fileName, data, config));
        return fileName;
    }

    private async setRoutingConfig(data: Buffer, config?: { lastModified?: number }): Promise<string> {
        let state = await this.getState();
        let writeTime = config?.lastModified || Date.now();
        let written: string[] = [];
        let errors: string[] = [];
        let seen = new Set<string>();
        console.log(`Writing storage routing config for ${this.getDebugName()} to every node (write time ${new Date(writeTime).toISOString()}): ${data.toString("utf8").slice(0, 2000)}`);
        for (let source of state.sources) {
            if (seen.has(source.config.url)) continue;
            seen.add(source.config.url);
            try {
                await source.write(archives => archives.set(ROUTING_FILE, data, { lastModified: writeTime }));
                written.push(source.config.url);
                console.log(`Wrote the storage routing config to ${source.config.url}`);
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
        await this.request({ write: true, route: getRoute(fileName), timeout: { uploadBytes: 0 } }, archives => archives.del(fileName));
    }

    // One write target per route range, lowest latency first. Within a shard the target is ALWAYS the first source in config order (see runPrimary - writes must stay on the same node): connectivity only decides which SHARD we pick, never which node within it, so a shard whose node is disconnected is dropped entirely when connectedOnly is set.
    private getVariableShardTargets(state: ChainState, config: { connectedOnly: boolean }): SourceWrapper[] {
        let targetsByRoute = new Map<string, SourceWrapper>();
        for (let source of state.sources) {
            if (!configAcceptsWrites(source.config)) continue;
            let routeKey = JSON.stringify(source.config.route || FULL_ROUTE);
            if (!targetsByRoute.has(routeKey)) {
                targetsByRoute.set(routeKey, source);
            }
        }
        let targets = [...targetsByRoute.values()];
        if (config.connectedOnly) {
            targets = targets.filter(x => x.isConnected());
        }
        sort(targets, x => x.getLatency());
        return targets;
    }

    /** The key setVariableShard would materialize for this VARIABLE_SHARD key (a value in the preferred shard's route range), without writing anything. */
    public async getShardKey(key: string): Promise<string> {
        if (!key.includes(VARIABLE_SHARD) || parseVariableRoute(key) !== undefined) {
            throw new Error(`getShardKey requires a key containing an unmaterialized ${JSON.stringify(VARIABLE_SHARD)}, got ${JSON.stringify(key)}`);
        }
        let state = await this.getState();
        let target = this.getVariableShardTargets(state, { connectedOnly: true })[0]
            || this.getVariableShardTargets(state, { connectedOnly: false })[0];
        if (!target) {
            throw new Error(`No source accepts writes for ${this.getDebugName()}, so there is no shard to materialize ${JSON.stringify(key)} into`);
        }
        return materializeShardKey(key, target);
    }

    private async setVariableShard(key: string, data: Buffer, config?: SetConfig): Promise<string> {
        let recheckedAvailability = false;
        // There's no point talking to a shard whose node was fast but is now disconnected - only when no connected shard works do we recheck availability and try every shard
        let connectedOnly = true;
        while (true) {
            let state = await this.getState();
            let targets = this.getVariableShardTargets(state, { connectedOnly });
            let errors: string[] = [];
            for (let target of targets) {
                let fullKey = materializeShardKey(key, target);
                try {
                    // The shard picking already retries across shards, so a stuck shard just costs its timeout and we move on
                    await this.applySmartTimeout({ uploadBytes: data.length }, target, () => target.write(archives => archives.set(fullKey, data, config)));
                    return fullKey;
                } catch (e) {
                    let message = String((e as Error).stack ?? e);
                    if (message.includes(SMART_TIMEOUT_MARKER)) {
                        console.error(`Variable-shard write target ${target.getDebugName()} timed out; moving to the next-lowest-latency shard: ${message}`);
                        errors.push(message);
                        continue;
                    }
                    if (target.isConnected()) throw e;
                    target.noteFailure();
                    console.log(`Variable-shard write target ${target.getDebugName()} is down; moving to the next-lowest-latency shard`);
                    errors.push(message);
                }
            }
            if (!recheckedAvailability) {
                recheckedAvailability = true;
                connectedOnly = false;
                await this.recheckAvailability();
                continue;
            }
            throw new Error(`Every variable-shard write target failed for ${this.getDebugName()}: ${errors.join(" | ") || "no sources accept writes"}`);
        }
    }

    public async setLargeFile(config: { path: string; lastModified?: number; getNextData(): Promise<Buffer | undefined> }): Promise<void> {
        if (config.path.includes(VARIABLE_SHARD) && parseVariableRoute(config.path) === undefined) {
            throw new Error(`setLargeFile does not support VARIABLE_SHARD keys (there is no way to return the materialized key); write the file with set, or materialize the key yourself. Key: ${JSON.stringify(config.path)}`);
        }
        let route = getRoute(config.path);
        let recheckedAvailability = false;
        while (true) {
            let state = await this.getState();
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
                await watchSlowPromise(`setLargeFile|${config.path}`, target.write(archives => archives.setLargeFile(config)));
                return;
            } catch (e) {
                if (!target.isConnected()) {
                    target.noteFailure();
                }
                throw e;
            }
        }
    }

    public async getURL(path: string): Promise<string> {
        let urls = await this.getURLs(path);
        if (!urls.length) {
            throw new Error(`No public source covering route ${getRoute(path)} to build a URL from for ${this.getDebugName()}`);
        }
        return urls[0];
    }

    /** Every URL that could serve this path: public sources matching both the path's route and the current valid window. The first is the write node's (first matching source in config order, see runPrimary - the one guaranteed current); the rest are ranked fastest-first by measured latency. Empty when none qualify. */
    public async getURLs(path: string): Promise<string[]> {
        return (await this.getGetURLs())(path);
    }

    /** getURLs, but after the one await (initialization) the returned function is synchronous: everything underneath - route hashing, window checks, latencies, URL building - is synchronous, and the closure always reads the newest adopted config, so it stays correct across config refreshes. */
    public async getGetURLs(): Promise<(path: string) => string[]> {
        let initialState = await this.getState();
        return this.makeGetURLs(initialState, { writeNodeFirst: true });
    }

    /** getGetURLs, but sorted purely by latency - the write node gets no special first position. For read-only consumers that just want the fastest host. */
    public async getGetFastURLs(): Promise<(path: string) => string[]> {
        let initialState = await this.getState();
        return this.makeGetURLs(initialState, { writeNodeFirst: false });
    }

    private makeGetURLs(initialState: ChainState, config: { writeNodeFirst: boolean }): (path: string) => string[] {
        return (path: string) => {
            let state = this.latestState || initialState;
            let route = getRoute(path);
            let sources: SourceWrapper[] = [];
            for (let source of state.sources) {
                if (!(source.config.public ?? true)) continue;
                if (!routeContains(source.config.route, route)) continue;
                if (!configWindowCurrent(source.config)) continue;
                sources.push(source);
            }
            let ordered: SourceWrapper[];
            if (config.writeNodeFirst) {
                let rest = sources.slice(1);
                sort(rest, x => x.getLatency());
                ordered = [...sources.slice(0, 1), ...rest];
            } else {
                ordered = [...sources];
                sort(ordered, x => x.getLatency());
            }
            let urls = ordered.map(x => buildFileUrl(getBucketBaseUrl(x.config.url), path));
            return [...new Set(urls)];
        };
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

export function createArchives(config: RemoteConfig | RemoteConfigBase, options?: ArchivesChainOptions): ArchivesChain {
    return new ArchivesChain(config, options);
}

async function callServer<T>(url: string, run: (controller: typeof RemoteStorageController.nodes[string]) => Promise<T>): Promise<T> {
    SocketFunction.ENABLE_CLIENT_MODE = true;
    let parsed = parseStorageUrl(url);
    let nodeId = SocketFunction.connect({ address: parsed.address, port: parsed.port });
    let controller = RemoteStorageController.nodes[nodeId];
    try {
        return await run(controller);
    } catch (e) {
        if (!String((e as Error).stack ?? e).includes(STORAGE_NOT_AUTHENTICATED)) throw e;
        await authenticateStorage({ address: parsed.address, port: parsed.port, nodeId });
        return await run(controller);
    }
}

export async function listServerBuckets(config: { url: string; account: string }): Promise<ServerBucketInfo[]> {
    return await callServer(config.url, controller => controller.listBuckets(config.account));
}

/** The live, in-memory state of one bucket on a server (routing config included), or a string saying why it is unavailable. Cheap - it never touches the server's disk - but only works while that bucket is loaded there. */
export async function getServerActiveBucket(config: { url: string; account: string; bucketName: string }): Promise<ActiveBucketInfo | string> {
    return await callServer(config.url, controller => controller.getActiveBucket(config.account, config.bucketName));
}

/** The buckets a server currently has loaded. Admin only, so in practice this is our own machine's other process - a deploy successor asking its predecessor what is actually in use. */
export async function listServerActiveBucketKeys(config: { url: string }): Promise<{ account: string; bucketName: string }[]> {
    return await callServer(config.url, controller => controller.adminListActiveBuckets());
}

/** Tells a server to load one of its buckets into memory (starting its synchronization) and returns its live state, or a string saying why it could not be loaded. Only touches that server - nothing is written and no other source is contacted. */
export async function activateServerBucket(config: { url: string; account: string; bucketName: string }): Promise<ActiveBucketInfo | string> {
    return await callServer(config.url, controller => controller.activateBucket(config.account, config.bucketName));
}

/** Zeroes the write statistics listServerBuckets reports, for every bucket in the account. */
export async function clearServerWriteStats(config: { url: string; account: string }): Promise<{ clearedBuckets: number }> {
    return await callServer(config.url, controller => controller.clearWriteStats(config.account));
}

export async function getBucketInfo(config: { url: string }): Promise<ArchivesConfig> {
    let remote = new ArchivesRemote({ url: config.url, waitForAccess: false });
    return await remote.getConfig();
}
