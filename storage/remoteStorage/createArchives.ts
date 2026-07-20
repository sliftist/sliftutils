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
    normalizeRemoteConfig, normalizeSource, serializeRemoteConfig,
    getRoute, routeContains, parseVariableRoute,
} from "./remoteConfig";
import { resolveIntermediateSources } from "./intermediateSources";
import { SocketFunction } from "socket-function/SocketFunction";
import { ArchivesRemote, parseStorageUrl, authenticateStorage } from "./ArchivesRemote";
import { onServerRoutingChanged } from "./storageClientController";
import { ArchivesBackblaze } from "../backblaze";
import { getStorageServerConfigOptional, getLocalArchives, ServerBucketInfo, ActiveBucketInfo } from "./storageServerState";
import { RemoteStorageController, STORAGE_NOT_AUTHENTICATED } from "./storageController";
import { SourceWrapper, RETRY_START_DELAY, RETRY_MAX_DELAY, RETRY_GROWTH } from "./sourceWrapper";

const CONFIG_POLL_INTERVAL = 5 * 60 * 1000;
const WRONG_TARGET_BOUNDARY_WINDOW = 30 * 1000;
const WRONG_TARGET_BOUNDARY_RETRY_DELAY = 15 * 1000;
const CONFIG_REFRESH_THROTTLE = 30 * 1000;
const AVAILABILITY_RECHECK_THROTTLE = 5 * 1000;

/** The address, port, account, and bucket name a bucket routing URL addresses. Throws when the URL isn't a hosted bucket routing URL (https://host:port/file/<account>/<bucketName>/storage/storagerouting.json). */
export { parseHostedUrl, parseBackblazeUrl, getBucketBaseUrl } from "./remoteConfig";

export function createApiArchives(source: HostedConfig | BackblazeConfig): IArchives {
    if (source.type === "backblaze") {
        return new ArchivesBackblaze({ bucketName: parseBackblazeUrl(source.url).bucketName, public: source.public, immutable: source.immutable, allowedOrigins: source.allowedOrigins });
    }
    let parsed = parseHostedUrl(source.url);
    let server = isNode() && getStorageServerConfigOptional() || undefined;
    if (server && parsed.address === server.domain && parsed.port === server.port) {
        return getLocalArchives(parsed.account, parsed.bucketName);
    }
    return new ArchivesRemote({ url: source.url, waitForAccess: false });
}

type ChainState = {
    config: RemoteConfig;
    sources: SourceWrapper[];
};

function configWindowCurrent(config: HostedConfig | BackblazeConfig): boolean {
    let now = Date.now();
    let [start, end] = config.validWindow;
    return start <= now && now < end;
}

function configAcceptsWrites(config: HostedConfig | BackblazeConfig): boolean {
    return configWindowCurrent(config);
}

export class ArchivesChain implements IArchives {
    private configured: RemoteConfig;
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
        let fetches = await Promise.all(configs.map(async sourceConfig => {
            let probe = await SourceWrapper.create(sourceConfig, { background: false });
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
            return { config: active, sources };
        } finally {
            for (let fetch of fetches) {
                fetch.probe.dispose();
            }
        }
    }

    private async createChainSource(sourceConfig: HostedConfig | BackblazeConfig): Promise<SourceWrapper> {
        let source = await SourceWrapper.create(sourceConfig);
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
        for (let leftovers of oldByConfig.values()) {
            for (let leftover of leftovers) {
                leftover.dispose();
            }
        }
        this.activeConfig = latest;
        this.statePromise = Promise.resolve({ config: latest, sources });
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
            if (!recheckedAvailability) {
                recheckedAvailability = true;
                await this.recheckAvailability();
                state = await this.getState();
                continue;
            }
            throw new Error(`All sources failed for ${this.getDebugName()}${config.route !== undefined && ` (route ${config.route})` || ""}: ${errors.join(" | ") || "no sources available"}`);
        }
    }

    private async runWrite<T>(route: number | undefined, run: (archives: IArchives) => Promise<T>): Promise<T> {
        let retriedWrongWindow = false;
        let retriedWrongRoute = false;
        let recheckedAvailability = false;
        while (true) {
            let state = await this.getState();
            let target = state.sources.find(x => configAcceptsWrites(x.config) && (route === undefined || routeContains(x.config.route, route)));
            if (!target) {
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
    public async hasWriteAccess(): Promise<boolean> {
        let state = await this.getState();
        for (let source of state.sources) {
            if (!configAcceptsWrites(source.config)) continue;
            if (!await source.hasWriteAccess()) return false;
        }
        return true;
    }

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
        await this.request({ write: true, route: getRoute(fileName) }, archives => archives.del(fileName));
    }

    private async setVariableShard(key: string, data: Buffer, config?: { lastModified?: number }): Promise<string> {
        let recheckedAvailability = false;
        while (true) {
            let state = await this.getState();
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
                    if (target.isConnected()) throw e;
                    target.noteFailure();
                    console.log(`Variable-shard write target ${target.getDebugName()} is down; moving to the next-lowest-latency shard`);
                    errors.push(String((e as Error).stack ?? e));
                }
            }
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

export function createArchives(config: RemoteConfig | RemoteConfigBase): ArchivesChain {
    return new ArchivesChain(config);
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
