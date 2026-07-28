import { isNode } from "socket-function/src/misc";
import { RemoteConfig, SourceConfig } from "../IArchives";
import { ROUTING_FILE, getConfigVersion, serializeRemoteConfig, normalizeRemoteConfig, normalizeSource } from "./remoteConfig";
import { SourceWrapper, RETRY_START_DELAY, RETRY_MAX_DELAY, RETRY_GROWTH } from "./sourceWrapper";
import { resolveIntermediateSources } from "./intermediateSources";
import { onServerRoutingChanged, trackChainConfig } from "./storageClientController";

// The LIFECYCLE of an ArchivesChain's state, and nothing else: initializing it (probing every configured source, deciding which routing config to run, writing ours out when it is the newest), the retry when initialization fails, the poll that adopts newer configs, the availability recheck, and the loop that keeps re-writing our config. None of this is request dispatch - the chain (createArchives.ts) asks the ChainStateManager for the current state and dispatches over it.

const CONFIG_POLL_INTERVAL = 5 * 60 * 1000;
const AVAILABILITY_RECHECK_THROTTLE = 5 * 1000;
// The routing config write is retried on this cadence while it is failing. A store that never received the config rejects every write aimed at it, so this not landing is a big deal - each failed attempt is logged.
export const CONFIG_WRITE_RETRY_INTERVAL = 5 * 60 * 1000;
// ...and even after success it is re-written on this cadence, in case a store lost it or a server appeared late
export const CONFIG_WRITE_REFRESH_INTERVAL = 60 * 60 * 1000;

export type ChainState = {
    config: RemoteConfig;
    sources: SourceWrapper[];
};

/** The chain's state and everything about HAVING one: init (with its retry), the config poll, availability rechecks, and the routing rewrite loop. The chain constructs one, asks it getState() on every call, and disposes it. */
export class ChainStateManager {
    public readonly configured: RemoteConfig;
    /** The newest adopted config - what getDebugName and dispatch decisions read. Starts as the configured one and moves with every adoption. */
    public activeConfig: RemoteConfig;
    private statePromise: Promise<ChainState> | undefined;
    // The resolved state, for synchronous access (getGetURLs) - always the newest adopted config, where statePromise may briefly lag during a rebuild
    private latestState: ChainState | undefined;
    private initRetryDelay = RETRY_START_DELAY;
    private initRetryTimer: ReturnType<typeof setTimeout> | undefined;
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private disposed = false;
    private unsubscribeRoutingPush: (() => void) | undefined;
    private routingRewriter: RoutingRewriteLoop;

    constructor(private config: {
        configured: RemoteConfig;
        debugName: () => string;
        /** See ArchivesChainOptions.directConnect. */
        directConnect?: boolean;
    }) {
        this.configured = config.configured;
        this.activeConfig = config.configured;
        this.routingRewriter = new RoutingRewriteLoop({
            configured: config.configured,
            debugName: config.debugName,
            latest: () => this.latestState,
        });
        this.unsubscribeRoutingPush = onServerRoutingChanged(() => {
            void this.refreshActiveConfig().catch((e: Error) => console.error(`Config refresh failed for ${this.config.debugName()}: ${e.stack ?? e}`));
        });
        // So a server can ask what config we intended for a store name (see StorageClientController.getRoutingConfigForName)
        this.untrackConfig = trackChainConfig({ configured: config.configured, active: () => this.activeConfig });
    }

    private untrackConfig: () => void;

    /** The newest adopted state, synchronously - undefined until the first init finishes. */
    public latest(): ChainState | undefined {
        return this.latestState;
    }

    public getState(): Promise<ChainState> {
        if (this.disposed) {
            return Promise.reject(new Error(`ArchivesChain ${this.config.debugName()} has been disposed`));
        }
        if (!this.statePromise) {
            let promise = this.init();
            this.statePromise = promise;
            promise.then(() => {
                this.initRetryDelay = RETRY_START_DELAY;
            }, (e: Error) => {
                if (this.disposed || this.initRetryTimer) return;
                console.error(`Storage init failed for ${this.config.debugName()}, retrying in ${Math.round(this.initRetryDelay / 1000)}s. ${e.stack ?? e}`);
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
        let probes = await probeSources(configs, readOnly);
        try {
            let { active, needsWrite, existing } = chooseStartupConfig({ configured: this.configured, probes, debugName: this.config.debugName() });
            let sources = await this.buildSources(active);
            let configWriteFailed = false;
            if (needsWrite) {
                console.log(`Storage routing config for ${this.config.debugName()} is out of date (stored version ${existing && getConfigVersion(existing) || "none"}, ours ${getConfigVersion(this.configured)})`);
                let { failures, total } = await writeRoutingToAllStores({ configured: this.configured, sources, debugName: this.config.debugName() });
                configWriteFailed = failures.length > 0;
                if (failures.length && failures.length === total) {
                    // Nobody has our config, so running on it would just disagree with every server. The stored one (when there is one) is what the servers actually run.
                    console.error(`The storage routing config for ${this.config.debugName()} (version ${getConfigVersion(this.configured)}) could not be written to ANY of the ${total} stores. ${existing && `Running on the stored config (version ${getConfigVersion(existing)}) until a write succeeds.` || `No stored config exists either, so servers will reject writes until this succeeds.`} Retrying in ${CONFIG_WRITE_RETRY_INTERVAL / 1000}s. Failures: ${failures.join(" | ")}`);
                    if (existing) {
                        active = existing;
                        for (let source of sources) {
                            source.dispose();
                        }
                        sources = await this.buildSources(active);
                    }
                } else if (failures.length) {
                    console.error(`The storage routing config for ${this.config.debugName()} (version ${getConfigVersion(this.configured)}) was written to ${total - failures.length} of ${total} stores. Retrying the rest in ${CONFIG_WRITE_RETRY_INTERVAL / 1000}s (they also pull it from the stores that have it). Failures: ${failures.join(" | ")}`);
                }
            }
            for (let source of sources) {
                let probe = probes.find(x => x.responded && x.sourceConfig.url === source.config.url);
                if (probe) {
                    source.seedLatency(probe.latency);
                }
            }
            this.activeConfig = active;
            this.startConfigPoll();
            let state: ChainState = { config: active, sources };
            this.latestState = state;
            this.routingRewriter.start(configWriteFailed);
            return state;
        } finally {
            disposeProbes(probes);
        }
    }

    /** Clientside, a config with public sources is served entirely over plain URL downloads - no API connection, no access grant, and no writing. directConnect opts out of that. */
    private isReadOnly(config: RemoteConfig): boolean {
        if (this.config.directConnect || isNode()) return false;
        return config.sources.map(normalizeSource).some(x => x.public);
    }

    private async createChainSource(sourceConfig: SourceConfig, readOnly: boolean): Promise<SourceWrapper> {
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
                console.error(`Checking for a new storage routing config failed for ${this.config.debugName()}: ${e.stack ?? e}`);
            });
        }, CONFIG_POLL_INTERVAL);
        (this.pollTimer as { unref?: () => void }).unref?.();
    }

    // Deduplicates concurrent refreshes (the poll timer and wrong-target write retries share this)
    private configRefreshInFlight: Promise<void> | undefined;
    public refreshActiveConfig(): Promise<void> {
        if (!this.configRefreshInFlight) {
            this.configRefreshInFlight = this.checkForNewConfig().finally(() => {
                this.configRefreshInFlight = undefined;
            });
        }
        return this.configRefreshInFlight;
    }

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
            throw new Error(`No storage source could give us the routing config for ${this.config.debugName()}: ${errors.join(" | ")}`);
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
        let strippedKey = (config: SourceConfig) => JSON.stringify({ ...config, validWindow: undefined });
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
    /** Every source failed: re-contact all of them (routing re-read + connection re-attempt) and adopt whatever config comes back. Throttled, and deduplicated across concurrent callers. */
    public recheckAvailability(): Promise<void> {
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
        console.log(`Every storage source failed for ${this.config.debugName()}; re-contacting all ${state.sources.length} sources (routing re-read + connection re-attempt)`);
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

    public dispose(): void {
        this.disposed = true;
        this.untrackConfig();
        this.unsubscribeRoutingPush?.();
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
        }
        if (this.initRetryTimer) {
            clearTimeout(this.initRetryTimer);
        }
        this.routingRewriter.dispose();
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

export type SourceProbe = {
    probe: SourceWrapper;
    sourceConfig: SourceConfig;
    responded: boolean;
    latency: number;
    existing: RemoteConfig | undefined;
    error: string;
};

/** One throwaway SourceWrapper per configured source, each asked for its stored routing config - which also measures first-contact latency, seeded into the real sources afterwards. The probes MUST be disposed (disposeProbes) once the caller is done with them. */
export async function probeSources(configs: SourceConfig[], readOnly: boolean): Promise<SourceProbe[]> {
    return await Promise.all(configs.map(async sourceConfig => {
        let probe = await SourceWrapper.create(sourceConfig, { background: false, readOnly });
        let start = Date.now();
        try {
            let existing = await probe.readRoutingConfig();
            return { probe, sourceConfig, responded: true, latency: Date.now() - start, existing, error: "" };
        } catch (e) {
            return { probe, sourceConfig, responded: false, latency: 0, existing: undefined, error: `${sourceConfig.url}: ${(e as Error).stack ?? e}` };
        }
    }));
}

export function disposeProbes(probes: SourceProbe[]): void {
    for (let probe of probes) {
        probe.probe.dispose();
    }
}

/**
 * Which routing config the chain should RUN: the newest of ours and every stored one. needsWrite
 * when ours is strictly the newest, meaning the stores have to be told about it. A stored config
 * with our exact version but DIFFERENT content wins without a write, loudly: config updates must
 * bump the version, or they are ignored - silently taking the changed one would make "what is the
 * bucket running" depend on which process started last.
 *
 * Throws when no source answered at all: with nothing stored and nobody to write to, there is no
 * config to run.
 */
export function chooseStartupConfig(config: { configured: RemoteConfig; probes: SourceProbe[]; debugName: string }): { active: RemoteConfig; needsWrite: boolean; existing: RemoteConfig | undefined } {
    let { configured, probes, debugName } = config;
    let found = probes.find(x => x.responded);
    if (!found) {
        throw new Error(`Storage initialization failed - no source answered. For ${debugName}: ${probes.map(x => x.error).join(" | ")}`);
    }
    let existing = found.existing;
    let active = configured;
    let needsWrite = true;
    if (existing && getConfigVersion(existing) >= getConfigVersion(configured)) {
        if (getConfigVersion(existing) === getConfigVersion(configured) && JSON.stringify(existing) !== JSON.stringify(configured)) {
            console.error(`Archives configuration updated without updating the version, for ${found.sourceConfig.url}. Updates will be ignored until you increase the version. Using: ${JSON.stringify(existing)}, ignoring: ${JSON.stringify(configured)}`);
        }
        active = existing;
        needsWrite = false;
    }
    if (needsWrite) {
        let best: RemoteConfig | undefined;
        let conflictUrl: string | undefined;
        for (let probe of probes) {
            let stored = probe.existing;
            if (!stored) continue;
            if (!best || getConfigVersion(stored) > getConfigVersion(best)) {
                best = stored;
            }
            if (getConfigVersion(stored) === getConfigVersion(configured) && JSON.stringify(stored) !== JSON.stringify(configured)) {
                conflictUrl = probe.sourceConfig.url;
            }
        }
        if (best && getConfigVersion(best) >= getConfigVersion(configured)) {
            if (conflictUrl && getConfigVersion(best) === getConfigVersion(configured)) {
                console.error(`Archives configuration updated without updating the version, for ${conflictUrl}. Updates will be ignored until you increase the version. Using: ${JSON.stringify(best)}, ignoring: ${JSON.stringify(configured)}`);
            }
            active = best;
            needsWrite = false;
        }
    }
    return { active, needsWrite, existing };
}

/**
 * Writes the given routing config to every configured store, one write per url+name: the write
 * lands in the store the entry NAMES, so two entries sharing a URL but naming different stores are
 * two separate deliveries - deduping by URL alone leaves the second store unconfigured forever. All
 * in parallel, every failure tolerated (no-write-access included - the attempt classifies it,
 * nothing pre-checks it): a down node must not stop the others from getting the config - they would
 * then reject writes as unconfigured precisely BECAUSE it never arrived - and it must never stop
 * the chain from starting. A store that missed it pulls it off its peers, and the rewrite loop
 * tries again (see RoutingRewriteLoop).
 */
export async function writeRoutingToAllStores(config: { configured: RemoteConfig; sources: SourceWrapper[]; debugName: string }): Promise<{ failures: string[]; total: number }> {
    let { configured, sources, debugName } = config;
    let routingData = serializeRemoteConfig(configured);
    let routingWriteTime = Math.floor(Date.now());
    let targets: SourceWrapper[] = [];
    let seen = new Set<string>();
    for (let source of sources) {
        let key = `${source.config.url}|${source.config.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(source);
    }
    console.log(`Writing routing config version ${getConfigVersion(configured)} for ${debugName} to all ${targets.length} stores (write time ${new Date(routingWriteTime).toISOString()}): ${targets.map(x => `${x.config.url} (store ${JSON.stringify(x.config.name)})`).join(", ")}`);
    let failures: string[] = [];
    await Promise.all(targets.map(async source => {
        try {
            await source.write(archives => archives.set(ROUTING_FILE, routingData, { lastModified: routingWriteTime }));
            console.log(`Wrote storage routing config version ${getConfigVersion(configured)} to ${source.config.url} (store ${JSON.stringify(source.config.name)})`);
        } catch (e) {
            failures.push(`${source.config.url} (store ${JSON.stringify(source.config.name)}): ${(e as Error).stack ?? e}`);
        }
    }));
    return { failures, total: targets.length };
}

/**
 * The periodic re-write of the chain's in-code config: failures retried on the short interval - a
 * store without the config rejects every write aimed at it, so this not landing is a big deal,
 * logged on every attempt - and even success repeated hourly, in case a store lost it. The failure
 * this exists for: a server whose trust was only granted AFTER startup, so the startup write was
 * rejected and nothing else would ever retry it.
 */
export class RoutingRewriteLoop {
    constructor(private config: {
        configured: RemoteConfig;
        debugName: () => string;
        /** The chain's newest adopted state: what decides whether ours is still the config to write, and the sources it is written through. Undefined until the first init finishes. */
        latest: () => { config: RemoteConfig; sources: SourceWrapper[] } | undefined;
    }) { }

    private timer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    /** (Re)arms the loop - called at the end of every init, with whether that init's write failed (which picks the short retry interval). */
    public start(failedAtStartup: boolean): void {
        this.schedule(failedAtStartup && CONFIG_WRITE_RETRY_INTERVAL || CONFIG_WRITE_REFRESH_INTERVAL);
    }

    public dispose(): void {
        this.disposed = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
    }

    private schedule(delay: number): void {
        if (this.disposed) return;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.rewrite().catch((e: Error) => {
                console.error(`Rewriting the storage routing config for ${this.config.debugName()} failed: ${e.stack ?? e}`);
                this.schedule(CONFIG_WRITE_RETRY_INTERVAL);
            });
        }, delay);
        (this.timer as { unref?: () => void }).unref?.();
    }

    private async rewrite(): Promise<void> {
        if (this.disposed) return;
        let configured = this.config.configured;
        let state = this.config.latest();
        if (!state) {
            this.schedule(CONFIG_WRITE_RETRY_INTERVAL);
            return;
        }
        // The bucket adopted a NEWER config than our in-code one, so ours is stale and every store would (rightly) refuse it
        if (getConfigVersion(state.config) > getConfigVersion(configured)) {
            this.schedule(CONFIG_WRITE_REFRESH_INTERVAL);
            return;
        }
        // Same version but different content: startup already decided the stored one wins until the version is bumped (see chooseStartupConfig), and re-writing ours would flip the bucket back and forth between the two
        if (getConfigVersion(state.config) === getConfigVersion(configured) && JSON.stringify(state.config) !== JSON.stringify(configured)) {
            this.schedule(CONFIG_WRITE_REFRESH_INTERVAL);
            return;
        }
        let { failures, total } = await writeRoutingToAllStores({ configured, sources: state.sources, debugName: this.config.debugName() });
        if (failures.length) {
            console.error(`The periodic routing config write for ${this.config.debugName()} (version ${getConfigVersion(configured)}) failed on ${failures.length} of ${total} stores - retrying in ${CONFIG_WRITE_RETRY_INTERVAL / 1000}s: ${failures.join(" | ")}`);
            this.schedule(CONFIG_WRITE_RETRY_INTERVAL);
            return;
        }
        this.schedule(CONFIG_WRITE_REFRESH_INTERVAL);
    }
}
