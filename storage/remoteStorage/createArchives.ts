import { sort, watchSlowPromise } from "socket-function/src/misc";
import { delay } from "socket-function/src/batching";
import {
    IArchives, RemoteConfig, RemoteConfigBase, SourceConfig,
    ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, ChangesAfterConfig, DelConfig, FindConfig, GetConfig, GetInfoConfig, MoveFileConfig, SetConfig, SetLargeFileConfig, STORAGE_WRONG_VALID_WINDOW,
    STORAGE_WRONG_ROUTE, STORAGE_NOT_CONFIGURED, FULL_ROUTE, VARIABLE_SHARD, LARGE_SET_THRESHOLD, bufferChunkStream,
} from "../IArchives";
import { copyArchiveFile } from "../archiveHelpers";
import {
    ROUTING_FILE, parseHostedUrl, parseBackblazeUrl, parseRoutingData, assertValidRemoteConfig,
    normalizeRemoteConfig, normalizeSource,
    getRoute, routeContains, parseVariableRoute, getBucketBaseUrl, buildFileUrl,
} from "./remoteConfig";
import { ArchivesUrl } from "./ArchivesUrl";
import { SocketFunction } from "socket-function/SocketFunction";
import { ArchivesRemote, parseStorageUrl, authenticateStorage } from "./ArchivesRemote";
import { ServerBucketInfo, ActiveBucketInfo } from "./storageServerState";
import { RemoteStorageController, STORAGE_NOT_AUTHENTICATED } from "./storageController";
import { SourceWrapper } from "./sourceWrapper";
import { ChainState, ChainStateManager } from "./chainStartup";
import { LogFileInfo, decodeLogFile, createLogSearcher } from "../StreamingLogs";
import { formatTime, formatDateTimeDetailed } from "socket-function/src/formatting/format";

// How many extra full passes over the sources fallback dispatch makes when EVERY source in a pass failed, before the operation throws (see GetConfig.retries) - most requests shouldn't fail at all, so a couple of blanket retries buys availability for almost nothing
const DEFAULT_FALLBACK_RETRIES = 3;
const FALLBACK_RETRY_DELAY = 2 * 1000;
const WRONG_TARGET_BOUNDARY_WINDOW = 30 * 1000;
const WRONG_TARGET_BOUNDARY_RETRY_DELAY = 15 * 1000;
const CONFIG_REFRESH_THROTTLE = 30 * 1000;
const PRIMARY_RETRY_TIMEOUT = 30 * 1000;
const PRIMARY_RETRY_DELAY = 2 * 1000;
const COVERING_RETRY_TIMEOUT = 30 * 1000;
const COVERING_RETRY_DELAY = 5 * 1000;
// Smart timeouts: an attempt gets this long to produce anything before we probe getInfo for the file's size (and the probe itself gets the same window)
const SMART_TIMEOUT_PROBE = 60 * 1000;
// Very generous assumed transfer rates - the resulting deadline exists to catch stuck sources, not slow ones
const SMART_TIMEOUT_DOWNLOAD_BYTES_PER_SECOND = 1024 * 1024;
const SMART_TIMEOUT_UPLOAD_BYTES_PER_SECOND = 512 * 1024;
// Marker in smart-timeout errors, so the read loop can log them and continue with the other sources (a connected source's other errors still throw)
const SMART_TIMEOUT_MARKER = "ARCHIVES_SMART_TIMEOUT_c41a9d";

// Sizes a generous per-attempt deadline. Get-style calls pass path: the size is only fetched (via getInfo) when the call turns out to be slow. Set-style calls pass uploadBytes, which they already know.
type SmartTimeout = {
    path?: string;
    uploadBytes?: number;
    // Names the operation in timeout errors - without it a deletion (a tombstone write, uploadBytes 0) reads as "Upload of 0 bytes", which looks like a bug rather than a delete
    label?: string;
};

/** The address, port, account, and bucket name a bucket routing URL addresses. Throws when the URL isn't a hosted bucket routing URL (https://host:port/file/<account>/<bucketName>/storage/storagerouting.json). */
export { parseHostedUrl, parseBackblazeUrl, getBucketBaseUrl } from "./remoteConfig";

/** A client for ONE source - see storeSources.ts. Re-exported here because a chain is built out of them. */
export { createApiArchives } from "./storeSources";

export type ArchivesChainOptions = {
    /** Outside of node we default to read-only downloads over the public URLs (no API connection) when the config has public sources. Set this to connect to the API anyway - needed for writing, listing, and any other operation the plain URL form cannot serve. */
    directConnect?: boolean;
};

function configWindowCurrent(config: SourceConfig): boolean {
    let now = Date.now();
    let [start, end] = config.validWindow;
    return start <= now && now < end;
}

function materializeShardKey(key: string, target: SourceWrapper): string {
    let [start, end] = target.config.route || FULL_ROUTE;
    return key.replace(VARIABLE_SHARD, VARIABLE_SHARD + "_" + (start + Math.random() * (end - start)));
}

/** Covers the whole key space with the AUTHORITATIVE sources: for each uncovered point, the FIRST source in config order whose route contains it - the exact selection every read and write uses, so listings come from the same nodes writes went to (read-your-writes). Never "fewest" or "widest": preferring a wide read replica over the routed write shards would serve listings from a node that only has the data second-hand. Returns undefined when the candidates leave a gap. */
function coverRoutes(candidates: SourceWrapper[]): SourceWrapper[] | undefined {
    let chosen: SourceWrapper[] = [];
    let covered = 0;
    while (covered < 1) {
        let next = candidates.find(x => routeContains(x.config.route, covered));
        if (!next) return undefined;
        chosen.push(next);
        let [, end] = next.config.route || FULL_ROUTE;
        covered = end;
    }
    return chosen;
}

/** READS ONLY. Drops sources that recently failed while disconnected - unless that would leave nothing, in which case a down source is still better than no source, and we retry it immediately. Never applies to writes (or noFallbacks reads of the write target): the write node is strictly the FIRST source matching the route and valid window, regardless of connectivity - a client's flaky view of the network must never scatter writes across the chain (spec: client writes are consistent, client reads are redundant). */
function preferUsable(sources: SourceWrapper[]): SourceWrapper[] {
    let usable = sources.filter(x => !x.isOnCooldown());
    return usable.length && usable || sources;
}

export class ArchivesChain implements IArchives {
    // The chain's state, and everything about having one (init + its retry, config polling/adoption, availability rechecks, the config rewrite loop), lives in the manager - what stays in this class is dispatch over that state
    private state: ChainStateManager;

    constructor(config: RemoteConfig | RemoteConfigBase, options?: ArchivesChainOptions) {
        this.state = new ChainStateManager({
            configured: normalizeRemoteConfig(config),
            debugName: () => this.getDebugName(),
            directConnect: options?.directConnect,
        });
    }

    public getDebugName() {
        let urls = this.state.activeConfig.sources.map(x => typeof x === "string" && x || (x as SourceConfig).url);
        return `chain ${urls.join(", ")}`;
    }

    // The ONE dispatch for every operation: no fallbacks (all writes by default, and noFallbacks reads) -> the primary node only, via runPrimary; everything else -> the shared fallback loop, trying sources in config order (or latency order for fast reads) and only moving on when one fails. Writes in the loop differ from reads only in calling source.write.
    private async run<T>(state: ChainState, config: { apiOnly?: boolean; write?: boolean; route?: number; noFallbacks?: boolean; fallbacks?: boolean; retries?: number; fast?: boolean; timeout?: SmartTimeout }, run: (archives: IArchives, sourceUrl: string) => Promise<T>): Promise<T> {
        if (config.fast && config.noFallbacks) {
            throw new Error(`fast and noFallbacks are mutually exclusive for ${this.getDebugName()}: noFallbacks only considers one source (the write node), so there is no order to speed up`);
        }
        if (config.noFallbacks || config.write && !config.fallbacks) {
            return await this.runPrimary(config, run);
        }
        let retries = config.retries;
        if (retries === undefined) {
            retries = DEFAULT_FALLBACK_RETRIES;
        }
        let recheckedAvailability = false;
        let retriedWrongTarget = false;
        let retriedPasses = 0;
        while (true) {
            let errors: string[] = [];
            let candidates = state.sources.filter(source =>
                (config.route === undefined || routeContains(source.config.route, config.route))
                && configWindowCurrent(source.config)
                // A write-blocked source (read-only mode, backblaze without credentials) can never take a write, so it is not a fallback candidate - its throw would end the pass early (it counts as connected)
                && !(config.write && (source.writeBlocked || !source.api))
            );
            let ordered = preferUsable(candidates);
            if (config.fast) {
                ordered = [...ordered];
                sort(ordered, x => x.getLatency());
            }
            let wrongTarget = false;
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
                    return await this.applySmartTimeout(config.timeout, source, () => {
                        if (config.write) return source.write(archives => run(archives, source.config.url));
                        return source.read(archives => run(archives, source.config.url));
                    });
                } catch (e) {
                    let message = String((e as Error).stack ?? e);
                    if (message.includes(SMART_TIMEOUT_MARKER)) {
                        console.error(`Source timed out for ${this.getDebugName()}, continuing with the next source: ${message}`);
                        errors.push(message);
                        continue;
                    }
                    // A wrong-window/route/unconfigured rejection means OUR config disagrees with the server's, so every source we'd fall back to is judged by the same stale config - refresh it and restart the pass instead
                    if ((message.includes(STORAGE_WRONG_VALID_WINDOW) || message.includes(STORAGE_WRONG_ROUTE) || message.includes(STORAGE_NOT_CONFIGURED)) && !retriedWrongTarget) {
                        retriedWrongTarget = true;
                        wrongTarget = true;
                        await this.prepareWrongTargetRetry(state, message.includes(STORAGE_WRONG_VALID_WINDOW) && "window" || message.includes(STORAGE_WRONG_ROUTE) && "route" || "unconfigured");
                        break;
                    }
                    // fallbacks means availability above everything: ANY failing source - down, misconfigured, rejecting, mid-switchover - is skipped and the next covering source takes the call. Only every source failing throws (below). Without fallbacks, a CONNECTED source's error is a real answer and throws.
                    if (config.fallbacks) {
                        console.error(`Source failed for ${this.getDebugName()}, falling back to the next source: ${message}`);
                        if (!source.isConnected()) source.noteFailure();
                        errors.push(message);
                        continue;
                    }
                    if (source.isConnected()) throw e;
                    source.noteFailure();
                    errors.push(message);
                }
            }
            if (wrongTarget) {
                state = await this.state.getState();
                continue;
            }
            if (!recheckedAvailability) {
                recheckedAvailability = true;
                await this.state.recheckAvailability();
                state = await this.state.getState();
                continue;
            }
            // Blanket retry of the whole pass, ANY error (see GetConfig.retries): most requests shouldn't fail at all, so retrying the rare failure - whatever it was - buys availability for almost nothing
            if (retriedPasses < retries) {
                retriedPasses++;
                console.warn(`Every source failed for ${this.getDebugName()}${config.route !== undefined && ` (route ${config.route})` || ""}; retrying the whole pass in ${FALLBACK_RETRY_DELAY / 1000}s (retry ${retriedPasses} of ${retries})`);
                await delay(FALLBACK_RETRY_DELAY);
                await this.state.recheckAvailability();
                state = await this.state.getState();
                continue;
            }
            throw new Error(`All sources failed for ${this.getDebugName()}${config.route !== undefined && ` (route ${config.route})` || ""} (after ${retriedPasses} retr${retriedPasses === 1 && "y" || "ies"}): ${errors.join(" | ") || "no sources available"}`);
        }
    }

    // Writes and noFallbacks reads are the same case: take the authoritative node - strictly the first source matching the route and valid window, whether it is up or down - and use it, never falling back to another node. It's important that writing always accesses the same node everywhere, even if that node is down - otherwise we're just writing into the void, and who knows if the writes will even be accepted, or clobbered, or what; and noFallbacks reads want the same node precisely because it is the one writes target. A slow call is almost always better than throwing, so a failing primary is retried (the SAME node, re-resolved each attempt since a config refresh can change which source is primary) until the deadline, then throws.
    private async runPrimary<T>(config: { write?: boolean; route?: number; timeout?: SmartTimeout }, run: (archives: IArchives, sourceUrl: string) => Promise<T>): Promise<T> {
        let retriedWrongWindow = false;
        let retriedWrongRoute = false;
        let retriedNotConfigured = false;
        let deadline = Date.now() + PRIMARY_RETRY_TIMEOUT;
        let attempt = 0;
        while (true) {
            attempt++;
            let attemptStart = Date.now();
            let state = await this.state.getState();
            let target = state.sources.find(x => configWindowCurrent(x.config) && (config.route === undefined || routeContains(x.config.route, config.route)));
            try {
                if (!target) {
                    throw new Error(`No valid source covers this request. No source is the ${config.write && "write target" || "primary read source"} for ${this.getDebugName()}${config.route !== undefined && ` (route ${config.route})` || ""} (every source is outside its valid window or outside the key's route)`);
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
                if (message.includes(STORAGE_NOT_CONFIGURED) && !retriedNotConfigured) {
                    retriedNotConfigured = true;
                    await this.prepareWrongTargetRetry(state, "unconfigured");
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
            await this.state.recheckAvailability();
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
            throw new Error(`${SMART_TIMEOUT_MARKER} Upload timed out. ${timeout.label || `Upload of ${timeout.uploadBytes} bytes`} to ${source.getDebugName()} timed out after ${Date.now() - start}ms (allowed ${Math.round(allowed)}ms: ${SMART_TIMEOUT_PROBE}ms base plus transfer at an assumed ${SMART_TIMEOUT_UPLOAD_BYTES_PER_SECOND} bytes/s)`);
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
            throw new Error(`${SMART_TIMEOUT_MARKER} Read timed out with no size probe. Read of ${JSON.stringify(path)} from ${source.getDebugName()}: no result after ${Date.now() - start}ms, and getInfo ${probeError && `failed (${probeError})` || `could not answer within ${SMART_TIMEOUT_PROBE}ms either`}`);
        }
        let allowed = Math.max(SMART_TIMEOUT_PROBE, info.size / SMART_TIMEOUT_DOWNLOAD_BYTES_PER_SECOND * 1000);
        let remaining = start + allowed - Date.now();
        if (remaining > 0) {
            let second = await Promise.race([callPromise.then(value => ({ value })), delay(remaining).then(() => undefined)]);
            if (second) return second.value;
        }
        abandon();
        throw new Error(`${SMART_TIMEOUT_MARKER} Read timed out. Read of ${JSON.stringify(path)} (${info.size} bytes) from ${source.getDebugName()} timed out after ${Date.now() - start}ms (allowed ${Math.round(allowed)}ms from the call's start, at an assumed ${SMART_TIMEOUT_DOWNLOAD_BYTES_PER_SECOND} bytes/s)`);
    }

    private lastConfigRefresh = 0;
    private async prepareWrongTargetRetry(state: ChainState, kind: "window" | "route" | "unconfigured"): Promise<void> {
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
        let reason = kind === "window" && "wrong valid window" || kind === "route" && "wrong route" || "the store has no configuration entry on that server";
        console.log(`Write rejected by ${this.getDebugName()} (${reason}): our config disagrees with the server's (likely stale, or a deploy switchover); refreshing it and retrying`);
        await this.state.refreshActiveConfig();
    }

    private async request<T>(config: { apiOnly?: boolean; write?: boolean; route?: number; noFallbacks?: boolean; fallbacks?: boolean; retries?: number; fast?: boolean; timeout?: SmartTimeout }, run: (archives: IArchives, sourceUrl: string) => Promise<T>): Promise<T> {
        let state = await this.state.getState();
        return await this.run(state, config, run);
    }

    public async waitingForAccess(): Promise<{ link: string; machineId: string; ip: string } | undefined> {
        let state = await this.state.getState();
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

    /** The sources that can serve a file right now, in dispatch order - the first is the write node, the one a plain read asks first. Each entry's url is what GetConfig.sourceUrl / GetInfoConfig.sourceUrl accept, so listing these and then reading with sourceUrl compares the copies the sources actually hold. */
    public async getFileSources(fileName: string): Promise<SourceConfig[]> {
        let state = await this.state.getState();
        let route = getRoute(fileName);
        return state.sources.filter(x => routeContains(x.config.route, route) && configWindowCurrent(x.config)).map(x => x.config);
    }

    // The one exact source a sourceUrl read means, no fallback of any kind - asking for a SPECIFIC source's copy and getting another's would defeat the point
    private async runOnSource<T>(sourceUrl: string, run: (archives: IArchives) => Promise<T>): Promise<T> {
        let state = await this.state.getState();
        let source = state.sources.find(x => x.config.url === sourceUrl);
        if (!source) {
            throw new Error(`No configured source has the url ${JSON.stringify(sourceUrl)} for ${this.getDebugName()} (sources: ${state.sources.map(x => x.config.url).join(", ")})`);
        }
        return await source.read(run);
    }

    public async get(fileName: string, config?: GetConfig): Promise<Buffer | undefined> {
        let result = await this.get2(fileName, config);
        return result && result.data || undefined;
    }
    /** get2, but trying sources in latency order (fastest first) instead of config order. While this is much faster, it might miss immediate writes: the write node is no longer tried first, so a lagging replica may answer with a slightly older value. Exclusive with noFallbacks (which only considers one source - the write node - so there is no order to speed up); passing both throws. */
    public async getFast(fileName: string, config?: GetConfig): Promise<{ data: Buffer; writeTime: number; size: number; url: string } | { data?: undefined; writeTime?: undefined; size?: undefined; url: string }> {
        if (config?.sourceUrl) {
            // A specific source leaves nothing for the latency ordering to decide
            return await this.get2(fileName, config);
        }
        return await this.request({ route: getRoute(fileName), noFallbacks: config?.noFallbacks, retries: config?.retries, fast: true, timeout: { path: fileName } }, async (archives, url) => {
            let result = await archives.get2(fileName, config);
            // Empty data is a tombstone, not content - see get2
            if (!result || !result.data || !result.data.length && !config?.includeTombstones && !(config?.range && result.size)) return { url };
            return { data: result.data, writeTime: result.writeTime, size: result.size, url };
        });
    }
    /** Always resolves with a url - the authority that answered. A value that doesn't exist is still an answer FROM a server, so it comes back as { url } with no data (never plain undefined); errors from every source throw instead. */
    public async get2(fileName: string, config?: GetConfig): Promise<{ data: Buffer; writeTime: number; size: number; url: string } | { data?: undefined; writeTime?: undefined; size?: undefined; url: string }> {
        const sourceUrl = config?.sourceUrl;
        if (sourceUrl) {
            return await this.runOnSource(sourceUrl, async archives => {
                let result = await archives.get2(fileName, config);
                if (!result || !result.data || !result.data.length && !config?.includeTombstones && !(config?.range && result.size)) return { url: sourceUrl };
                return { data: result.data, writeTime: result.writeTime, size: result.size, url: sourceUrl };
            });
        }
        return await this.request({ route: getRoute(fileName), noFallbacks: config?.noFallbacks, retries: config?.retries, timeout: { path: fileName } }, async (archives, url) => {
            let result = await archives.get2(fileName, config);
            // Empty data is a tombstone, not content (unless the caller asked for tombstones) - a ranged read of a REAL file can legitimately be empty though (range past EOF), which the total size distinguishes
            if (!result || !result.data || !result.data.length && !config?.includeTombstones && !(config?.range && result.size)) return { url };
            return { data: result.data, writeTime: result.writeTime, size: result.size, url };
        });
    }
    public async getInfo(fileName: string, config?: GetInfoConfig): Promise<{ writeTime: number; size: number; url: string } | undefined> {
        const sourceUrl = config?.sourceUrl;
        if (sourceUrl) {
            return await this.runOnSource(sourceUrl, async archives => {
                let result = await archives.getInfo(fileName, config);
                return result && { ...result, url: sourceUrl } || undefined;
            });
        }
        return await this.request({ route: getRoute(fileName), noFallbacks: config?.noFallbacks, retries: config?.retries }, async (archives, url) => {
            let result = await archives.getInfo(fileName, config);
            return result && { ...result, url } || undefined;
        });
    }

    // Without fallbacks: the AUTHORITATIVE covering ONLY - the first source per route in config order (the same node every write and read targets), down or not. It is NEVER excluded and NEVER substituted, so a listing that can't reach its write nodes retries those same nodes until the deadline and then fails, rather than quietly reading second-hand data off a replica or backblaze. exclude/cooldown/substitution apply ONLY when the caller opted into fallbacks.
    private selectCoveringSources(state: ChainState, config?: { fallbacks?: boolean; exclude?: Set<SourceWrapper> }): SourceWrapper[] {
        if (config?.fallbacks) {
            let candidates = state.sources.filter(x => configWindowCurrent(x.config) && x.api && !config.exclude?.has(x));
            let usable = candidates.filter(x => !x.isOnCooldown());
            let chosen = coverRoutes(usable) || coverRoutes(candidates);
            if (chosen) return chosen;
            throw new Error(`Cannot cover the full route space for ${this.getDebugName()}: the available sources leave a gap (some shards are down or URL-only)`);
        }
        let candidates = state.sources.filter(x => configWindowCurrent(x.config) && x.api);
        let chosen = coverRoutes(candidates);
        if (!chosen) {
            throw new Error(`Cannot cover the full route space for ${this.getDebugName()}: the available sources leave a gap (some shards are down or URL-only)`);
        }
        return chosen;
    }

    private async runOnCovering<T>(operation: string, run: (archives: IArchives) => Promise<T>, config?: { fallbacks?: boolean }): Promise<T[]> {
        let startTime = Date.now();
        let deadline = Date.now() + COVERING_RETRY_TIMEOUT;
        // Sources that failed during this call - with fallbacks, the next attempt covers their routes with the next source holding them instead
        let failed = new Set<SourceWrapper>();
        let tries = 0;
        while (true) {
            tries++;
            let state = await this.state.getState();
            // Errors name the OPERATION and the SPECIFIC sources that failed - "the find failed because source X is unavailable", never an anonymous failure attributed to the whole chain
            let outcome = await (async (): Promise<{ values: T[] } | { error: Error }> => {
                let covering: SourceWrapper[];
                try {
                    covering = this.selectCoveringSources(state, { fallbacks: config?.fallbacks, exclude: failed });
                } catch (e) {
                    return { error: new Error(`${operation} cannot run: ${(e as Error).message}`) };
                }
                let values: T[] = [];
                let failures: { source: SourceWrapper; error: Error }[] = [];
                let time = Date.now();
                await Promise.all(covering.map(async (source, index) => {
                    let api = source.api;
                    if (!api) {
                        failed.add(source);
                        failures.push({ source, error: new Error(`URL-only access, which cannot serve ${operation}`) });
                        return;
                    }
                    try {
                        values.push(await run(api));
                    } catch (e) {
                        if (!source.isConnected()) source.noteFailure();
                        failed.add(source);
                        failures.push({ source, error: e as Error });
                        console.log(`Failed after ${formatTime(Date.now() - time)} index ${index} of ${covering.length}`);
                    }
                }));
                if (!failures.length) return { values };
                if (failures.length === 1) {
                    return { error: new Error(`${operation} failed because source ${failures[0].source.getDebugName()} is unavailable: ${failures[0].error.message ?? failures[0].error}. Fallbacks = ${!!config?.fallbacks}. Tries = ${tries}, Took ${formatTime(Date.now() - startTime)}`) };
                }
                return { error: new Error(`${operation} failed because ${failures.length} of the ${covering.length} covering sources are unavailable: ${failures.map(x => `${x.source.getDebugName()}: ${x.error.message ?? x.error}`).join(" | ")}. Fallbacks = ${!!config?.fallbacks}. Tries = ${tries}, Took ${formatTime(Date.now() - startTime)}`) };
            })();
            if ("values" in outcome) return outcome.values;
            let error = outcome.error;
            // Substitution comes BEFORE the deadline check: a single connect timeout can eat the entire deadline, and giving up then - without ever trying the substitute that fallbacks exist for - throws exactly when falling back matters most. Substitution cannot loop past the deadline forever: every pass adds its failures to `failed`, so the substitutes run out with the sources.
            if (config?.fallbacks && failed.size) {
                let substitutable = false;
                try {
                    this.selectCoveringSources(state, { fallbacks: true, exclude: failed });
                    substitutable = true;
                } catch { }
                if (substitutable) {
                    console.warn(`(retrying with fallbacks) ${error.message}`);
                    continue;
                }
                // No substitute covers the failed routes - retry the failed sources themselves after the delay
                failed.clear();
            }
            if (Date.now() >= deadline) {
                throw error;
            }
            console.error(`${error.message}. Retrying in ${COVERING_RETRY_DELAY / 1000}s (giving up at ${formatDateTimeDetailed(deadline)}).`);
            void this.state.recheckAvailability();
            await delay(COVERING_RETRY_DELAY);
        }
    }

    public async find(prefix: string, config?: FindConfig): Promise<string[]> {
        return (await this.findInfo(prefix, config)).map(x => x.path);
    }
    public async findInfo(prefix: string, config?: FindConfig): Promise<ArchiveFileInfo[]> {
        let results = await this.runOnCovering(`The find of ${JSON.stringify(prefix)}`, archives => archives.findInfo(prefix, config), { fallbacks: config?.fallbacks });
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
        let results = await this.runOnCovering(`The changes listing since ${formatDateTimeDetailed(config.time)}`, archives => archives.getChangesAfter2(config));
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
        let statuses = await this.runOnCovering(`The sync status check`, async archives => {
            if (!archives.getSyncStatus) {
                throw new Error(`getSyncStatus is not supported: ${archives.getDebugName()} does not implement it`);
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
        let state = await this.state.getState();
        if (!state.sources.some(x => x.api)) return { remoteConfig: state.config };
        let config = await this.run(state, { apiOnly: true }, archives => archives.getConfig());
        return { ...config, remoteConfig: state.config };
    }
    public async hasWriteAccess(): Promise<boolean> {
        let state = await this.state.getState();
        for (let source of state.sources) {
            if (!configWindowCurrent(source.config)) continue;
            if (!await source.hasWriteAccess()) return false;
        }
        return true;
    }

    public async set(fileName: string, data: Buffer, config?: SetConfig): Promise<string> {
        if (!data.length) {
            throw new Error(`Empty write refused: set was called with an empty buffer for ${JSON.stringify(fileName)}: an empty file IS a deletion in this system and would read back as missing - call del instead`);
        }
        if (fileName === ROUTING_FILE) {
            return await this.setRoutingConfig(data, config);
        }
        if (fileName.includes(VARIABLE_SHARD) && parseVariableRoute(fileName) === undefined) {
            return await this.setVariableShard(fileName, data, config);
        }
        if (data.length > LARGE_SET_THRESHOLD) {
            // Streamed automatically so callers never have to call setLargeFile themselves when they already hold the buffer - one giant message would exceed the wire limit and lag every other client on the connection. The whole config goes with it (including fallbacks, which the buffer's restartStream makes possible): a file must not get different write semantics just for being big.
            await this.setLargeFile({ path: fileName, ...config, ...bufferChunkStream(data) });
            return fileName;
        }
        await this.request({ write: true, fallbacks: config?.fallbacks, retries: config?.retries, route: getRoute(fileName), timeout: { uploadBytes: data.length, label: `Upload of ${JSON.stringify(fileName)} (${data.length} bytes)` } }, archives => archives.set(fileName, data, config));
        return fileName;
    }

    private async setRoutingConfig(data: Buffer, config?: { lastModified?: number }): Promise<string> {
        // Checked before the first node is written to, not just by each node as it arrives: every server would reject it anyway, and finding that out one node at a time is how a config write ends up half-applied
        assertValidRemoteConfig(parseRoutingData(data));
        let state = await this.state.getState();
        let writeTime = Math.round(config?.lastModified || Date.now());
        let written: string[] = [];
        let errors: string[] = [];
        // One write per STORE, not per server: the write lands in the store the entry NAMES, so two entries sharing a URL but naming different stores are two separate deliveries - deduping by URL alone leaves the second store unconfigured forever
        let targets: SourceWrapper[] = [];
        let seen = new Set<string>();
        for (let source of state.sources) {
            let key = `${source.config.url}|${source.config.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            targets.push(source);
        }
        console.log(`Writing storage routing config for ${this.getDebugName()} to all ${targets.length} stores (write time ${formatDateTimeDetailed(writeTime)}): ${data.toString("utf8").slice(0, 2000)}`);
        await Promise.all(targets.map(async source => {
            let label = `${source.config.url} (store ${JSON.stringify(source.config.name)})`;
            try {
                await source.write(archives => archives.set(ROUTING_FILE, data, { lastModified: writeTime }));
                written.push(label);
                console.log(`Wrote the storage routing config to ${label}`);
            } catch (e) {
                errors.push(`${label}: ${(e as Error).stack ?? e}`);
            }
        }));
        await this.state.refreshActiveConfig();
        if (errors.length) {
            throw new Error(`Routing config write failed on some stores. For ${this.getDebugName()}: failed on ${errors.length} of ${targets.length} stores (succeeded on: ${written.join(", ") || "none"}): ${errors.join(" | ")}`);
        }
        return ROUTING_FILE;
    }
    public async del(fileName: string, config?: DelConfig): Promise<void> {
        await this.request({ write: true, fallbacks: config?.fallbacks, retries: config?.retries, route: getRoute(fileName), timeout: { uploadBytes: 0, label: `Deletion of ${JSON.stringify(fileName)}` } }, archives => archives.del(fileName, config));
    }

    /** See IArchives.undelete: restores a file marked for deletion, dispatched to the write node as SetConfig.undelete (the write node propagates the restore to its peers itself). */
    public async undelete(fileName: string): Promise<void> {
        // set refuses empty buffers, and an undelete carries no data - the byte is ignored
        let placeholder = Buffer.from([1]);
        await this.request({ write: true, route: getRoute(fileName), timeout: { uploadBytes: placeholder.length, label: `Undelete of ${JSON.stringify(fileName)}` } }, archives => archives.set(fileName, placeholder, { undelete: true }));
    }

    /** See IArchives.move. When one node is the write target for BOTH paths, that node moves the file itself - the bytes never come through us - with the same wrong-window/route re-resolution as any write. When the paths route to different shards no single node holds both, so the move degrades to a copy through us plus a delete, CONFIRMED at the destination before the source is touched. No smart timeout on the node-side move: it can be a big file's worth of node-side work, which the upload-sized deadlines would misjudge. */
    public async move(config: MoveFileConfig): Promise<void> {
        if (config.fromPath === config.toPath) return;
        if (config.fromPath === ROUTING_FILE || config.toPath === ROUTING_FILE) {
            throw new Error(`The routing config ${JSON.stringify(ROUTING_FILE)} cannot be moved`);
        }
        let fromRoute = getRoute(config.fromPath);
        let toRoute = getRoute(config.toPath);
        let state = await this.state.getState();
        let target = state.sources.find(x => configWindowCurrent(x.config) && routeContains(x.config.route, fromRoute));
        if (target && routeContains(target.config.route, toRoute)) {
            await this.request({ write: true, route: fromRoute }, async archives => {
                if (!archives.move) {
                    throw new Error(`Move is not supported by this source: ${archives.getDebugName()} (moving ${JSON.stringify(config.fromPath)} to ${JSON.stringify(config.toPath)})`);
                }
                await archives.move(config);
            });
            return;
        }
        // Inline rather than moveArchiveFile, which - given one archives that implements move - would just call back into this method
        let copied = await copyArchiveFile({ from: this, to: this, path: config.fromPath, toPath: config.toPath });
        if (!copied) {
            // Undefined is two cases (see copyArchiveFile) - asking the source which one keeps the error honest
            let sourceInfo = await this.getInfo(config.fromPath);
            if (sourceInfo) {
                throw new Error(`Move refused - a newer file exists at the destination. Cannot move ${JSON.stringify(config.fromPath)} (${sourceInfo.size} bytes at ${formatDateTimeDetailed(sourceInfo.writeTime)}) to ${JSON.stringify(config.toPath)}: the copy was refused rather than roll it back (${this.getDebugName()}) - the source is left untouched`);
            }
            throw new Error(`Move source does not exist. Cannot move ${JSON.stringify(config.fromPath)} to ${JSON.stringify(config.toPath)}: not found on ${this.getDebugName()}`);
        }
        let confirmed = await this.getInfo(config.toPath);
        if (!confirmed) {
            throw new Error(`Move copy could not be confirmed - the source is kept. Not deleting ${JSON.stringify(config.fromPath)} after copying it to ${JSON.stringify(config.toPath)}: the destination does not report it (${this.getDebugName()})`);
        }
        await this.del(config.fromPath);
    }

    // One write target per route range, lowest latency first. Within a shard the target is ALWAYS the first source in config order (see runPrimary - writes must stay on the same node): connectivity only decides which SHARD we pick, never which node within it, so a shard whose node is disconnected is dropped entirely when connectedOnly is set.
    private getVariableShardTargets(state: ChainState, config: { connectedOnly: boolean }): SourceWrapper[] {
        let targetsByRoute = new Map<string, SourceWrapper>();
        for (let source of state.sources) {
            if (!configWindowCurrent(source.config)) continue;
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
        let state = await this.state.getState();
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
            let state = await this.state.getState();
            let targets = this.getVariableShardTargets(state, { connectedOnly });
            let errors: string[] = [];
            for (let target of targets) {
                let fullKey = materializeShardKey(key, target);
                try {
                    // The shard picking already retries across shards, so a stuck shard just costs its timeout and we move on. Large data streams via setLargeFile - the key is already materialized here, so the no-VARIABLE_SHARD restriction on setLargeFile doesn't apply.
                    await this.applySmartTimeout({ uploadBytes: data.length, label: `Variable-shard upload of ${JSON.stringify(fullKey)} (${data.length} bytes)` }, target, () => {
                        if (data.length > LARGE_SET_THRESHOLD) {
                            return target.write(archives => archives.setLargeFile({ path: fullKey, ...config, ...bufferChunkStream(data) }));
                        }
                        return target.write(archives => archives.set(fullKey, data, config)) as any;
                    });
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
                await this.state.recheckAvailability();
                continue;
            }
            throw new Error(`Every variable-shard write target failed for ${this.getDebugName()}: ${errors.join(" | ") || "no sources accept writes"}`);
        }
    }

    /** A large file is written exactly like a small one - same write node, same wrong-window/route re-resolution, same fallbacks - so a value's SIZE never decides its write semantics (set streams through here past LARGE_SET_THRESHOLD, and a file that grew past it must not suddenly lose the availability its caller asked for). The one difference: every attempt after the first has to rewind the stream, so a config without restartStream gets a single attempt. */
    public async setLargeFile(config: SetLargeFileConfig): Promise<void> {
        if (config.path.includes(VARIABLE_SHARD) && parseVariableRoute(config.path) === undefined) {
            throw new Error(`setLargeFile does not support VARIABLE_SHARD keys (there is no way to return the materialized key); write the file with set, or materialize the key yourself. Key: ${JSON.stringify(config.path)}`);
        }
        let route = getRoute(config.path);
        const restartStream = config.restartStream;
        if (!restartStream) {
            await this.setLargeFileOnce(config, route);
            return;
        }
        let attempt = 0;
        await this.request({ write: true, fallbacks: config.fallbacks, retries: config.retries, route }, async archives => {
            attempt++;
            // The previous attempt consumed some (or all) of the stream, and this source needs the file from its first byte
            if (attempt > 1) await restartStream();
            await watchSlowPromise(`setLargeFile|${config.path}`, archives.setLargeFile(config));
        });
    }

    // A stream that cannot rewind gets exactly ONE attempt at the write node: retrying anywhere (another source, or this one again) would send whatever is left of an already-consumed stream as if it were the whole file.
    private async setLargeFileOnce(config: SetLargeFileConfig, route: number): Promise<void> {
        let recheckedAvailability = false;
        while (true) {
            let state = await this.state.getState();
            let target = state.sources.find(x => configWindowCurrent(x.config) && routeContains(x.config.route, route));
            if (!target) {
                if (!recheckedAvailability) {
                    recheckedAvailability = true;
                    await this.state.recheckAvailability();
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
        let initialState = await this.state.getState();
        return this.makeGetURLs(initialState, { writeNodeFirst: true });
    }

    /** getGetURLs, but sorted purely by latency - the write node gets no special first position. For read-only consumers that just want the fastest host. */
    public async getGetFastURLs(): Promise<(path: string) => string[]> {
        let initialState = await this.state.getState();
        return this.makeGetURLs(initialState, { writeNodeFirst: false });
    }

    private makeGetURLs(initialState: ChainState, config: { writeNodeFirst: boolean }): (path: string) => string[] {
        return (path: string) => {
            let state = this.state.latest() || initialState;
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
        this.state.dispose();
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
    return await callServer(config.url, controller => controller.listBuckets({ account: config.account }));
}

/** The live, in-memory state of one bucket on a server (routing config included), or a string saying why it is unavailable. Cheap - it never touches the server's disk - but only works while that bucket is loaded there. */
export async function getServerActiveBucket(config: { url: string; account: string; bucketName: string }): Promise<ActiveBucketInfo | string> {
    return await callServer(config.url, controller => controller.getActiveBucket({ account: config.account, bucketName: config.bucketName }));
}

/** The buckets a server currently has loaded. Admin only, so in practice this is our own machine's other process - a deploy successor asking its predecessor what is actually in use. */
export async function listServerActiveBucketKeys(config: { url: string }): Promise<{ account: string; bucketName: string }[]> {
    return await callServer(config.url, controller => controller.adminListActiveBuckets());
}

/** Tells a server to load one of its buckets into memory (starting its synchronization) and returns its live state, or a string saying why it could not be loaded. Only touches that server - nothing is written and no other source is contacted. */
export async function activateServerBucket(config: { url: string; account: string; bucketName: string }): Promise<ActiveBucketInfo | string> {
    return await callServer(config.url, controller => controller.activateBucket({ account: config.account, bucketName: config.bucketName }));
}

/** Zeroes the write statistics listServerBuckets reports, for every bucket in the account. */
export async function clearServerWriteStats(config: { url: string; account: string }): Promise<{ clearedBuckets: number }> {
    return await callServer(config.url, controller => controller.clearWriteStats({ account: config.account }));
}

/** The operation-log files ONE storage server holds (every server logs only its own operations - see listAllServerLogFiles for the whole fleet). The names carry pid/thread/time-range/entry-count metadata; see LogFileInfo. */
export async function listServerLogFiles(config: { url: string; account: string }): Promise<LogFileInfo[]> {
    return await callServer(config.url, controller => controller.listLogFiles({ account: config.account }));
}

/** Every server's log files at once, one entry per url - a server that cannot answer reports its error instead of failing the rest. */
export async function listAllServerLogFiles(config: { urls: string[]; account: string }): Promise<{ url: string; files?: LogFileInfo[]; error?: string }[]> {
    return await Promise.all(config.urls.map(async url => {
        try {
            return { url, files: await listServerLogFiles({ url, account: config.account }) };
        } catch (e) {
            return { url, error: String((e as Error).stack ?? e) };
        }
    }));
}

/** Downloads the named log files off one server and decodes them into the logged objects (the wire always carries them LZ4-compressed - live files are compressed in memory server-side). */
export async function getServerLogs(config: { url: string; account: string; names: string[] }): Promise<{ name: string; entries: unknown[] }[]> {
    return await callServer(config.url, async controller => {
        let results: { name: string; entries: unknown[] }[] = [];
        for (let name of config.names) {
            let data = await controller.getLogFile({ account: config.account, name });
            results.push({ name, entries: decodeLogFile(Buffer.from(data)) });
        }
        return results;
    });
}

/** getServerLogs, but SEARCHED instead of fully decoded: the raw JSON text is substring-matched (every search string must appear in a statement - see createLogSearcher), and only the matching statements are decoded into objects. Far cheaper than decoding whole files to look for one path or caller. */
export async function searchServerLogs(config: { url: string; account: string; names: string[]; searches: string[] }): Promise<{ name: string; entries: unknown[] }[]> {
    return await callServer(config.url, async controller => {
        let results: { name: string; entries: unknown[] }[] = [];
        for (let name of config.names) {
            let data = await controller.getLogFile({ account: config.account, name });
            results.push({ name, entries: createLogSearcher(Buffer.from(data))(config.searches) });
        }
        return results;
    });
}

export async function getBucketInfo(config: { url: string }): Promise<ArchivesConfig> {
    // getConfig is bucket-level (no store selection), so the fabricated sourceConfig never has to match anything
    let remote = new ArchivesRemote({ url: config.url, waitForAccess: false, sourceConfig: normalizeSource(config.url) });
    return await remote.getConfig();
}
