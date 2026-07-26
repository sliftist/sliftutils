import { RemoteConfig, SourceConfig } from "../IArchives";
import { SourceWrapper } from "./sourceWrapper";
export declare const CONFIG_WRITE_RETRY_INTERVAL: number;
export declare const CONFIG_WRITE_REFRESH_INTERVAL: number;
export type ChainState = {
    config: RemoteConfig;
    sources: SourceWrapper[];
};
/** The chain's state and everything about HAVING one: init (with its retry), the config poll, availability rechecks, and the routing rewrite loop. The chain constructs one, asks it getState() on every call, and disposes it. */
export declare class ChainStateManager {
    private config;
    readonly configured: RemoteConfig;
    /** The newest adopted config - what getDebugName and dispatch decisions read. Starts as the configured one and moves with every adoption. */
    activeConfig: RemoteConfig;
    private statePromise;
    private latestState;
    private initRetryDelay;
    private initRetryTimer;
    private pollTimer;
    private disposed;
    private unsubscribeRoutingPush;
    private routingRewriter;
    constructor(config: {
        configured: RemoteConfig;
        debugName: () => string;
        /** See ArchivesChainOptions.directConnect. */
        directConnect?: boolean;
    });
    /** The newest adopted state, synchronously - undefined until the first init finishes. */
    latest(): ChainState | undefined;
    getState(): Promise<ChainState>;
    private init;
    /** Clientside, a config with public sources is served entirely over plain URL downloads - no API connection, no access grant, and no writing. directConnect opts out of that. */
    private isReadOnly;
    private createChainSource;
    private buildSources;
    private startConfigPoll;
    private configRefreshInFlight;
    refreshActiveConfig(): Promise<void>;
    private fetchLatestConfig;
    private checkForNewConfig;
    private adoptNewConfig;
    private lastAvailabilityRecheck;
    private availabilityRecheckInFlight;
    /** Every source failed: re-contact all of them (routing re-read + connection re-attempt) and adopt whatever config comes back. Throttled, and deduplicated across concurrent callers. */
    recheckAvailability(): Promise<void>;
    private recheckAvailabilityNow;
    dispose(): void;
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
export declare function probeSources(configs: SourceConfig[], readOnly: boolean): Promise<SourceProbe[]>;
export declare function disposeProbes(probes: SourceProbe[]): void;
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
export declare function chooseStartupConfig(config: {
    configured: RemoteConfig;
    probes: SourceProbe[];
    debugName: string;
}): {
    active: RemoteConfig;
    needsWrite: boolean;
    existing: RemoteConfig | undefined;
};
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
export declare function writeRoutingToAllStores(config: {
    configured: RemoteConfig;
    sources: SourceWrapper[];
    debugName: string;
}): Promise<{
    failures: string[];
    total: number;
}>;
/**
 * The periodic re-write of the chain's in-code config: failures retried on the short interval - a
 * store without the config rejects every write aimed at it, so this not landing is a big deal,
 * logged on every attempt - and even success repeated hourly, in case a store lost it. The failure
 * this exists for: a server whose trust was only granted AFTER startup, so the startup write was
 * rejected and nothing else would ever retry it.
 */
export declare class RoutingRewriteLoop {
    private config;
    constructor(config: {
        configured: RemoteConfig;
        debugName: () => string;
        /** The chain's newest adopted state: what decides whether ours is still the config to write, and the sources it is written through. Undefined until the first init finishes. */
        latest: () => {
            config: RemoteConfig;
            sources: SourceWrapper[];
        } | undefined;
    });
    private timer;
    private disposed;
    /** (Re)arms the loop - called at the end of every init, with whether that init's write failed (which picks the short retry interval). */
    start(failedAtStartup: boolean): void;
    dispose(): void;
    private schedule;
    private rewrite;
}
