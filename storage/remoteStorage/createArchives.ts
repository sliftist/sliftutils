module.allowclient = true;

import { isNode } from "socket-function/src/misc";
import {
    IArchives, RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig,
    ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus,
} from "../IArchives";
import {
    ROUTING_FILE, getConfigVersion, parseHostedUrl, parseBackblazeUrl,
    normalizeRemoteConfig, normalizeSource, parseRoutingData, serializeRemoteConfig,
} from "./remoteConfig";
import { ArchivesRemote } from "./ArchivesRemote";
import { ArchivesBackblaze } from "../backblaze";
import { getStorageServerConfigOptional, getLocalArchives } from "./storageServerState";
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
            sources.push(await SourceWrapper.create(sourceConfig));
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

    // Runs a request against the first available source, moving to the next one ONLY when the
    // source's WebSocket is down (checked directly - never by inspecting the error, which is
    // arbitrary data). An error from a connected source is an application error and throws as-is,
    // e.g. a permission error on write. A down source gets its background reconnect kicked.
    private async run<T>(state: ChainState, config: { apiOnly?: boolean; write?: boolean }, run: (archives: IArchives) => Promise<T>): Promise<T> {
        let errors: string[] = [];
        for (let source of state.sources) {
            if (config.write && source.config.syncOptions?.noWriteBack) continue;
            if (!source.isConnected()) {
                source.noteFailure();
                errors.push(`${source.config.url} is not connected`);
                continue;
            }
            try {
                if (config.write) {
                    return await source.write(run);
                }
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
        throw new Error(`All sources failed for ${this.getDebugName()}: ${errors.join(" | ") || "no sources available"}`);
    }

    private async request<T>(config: { apiOnly?: boolean; write?: boolean }, run: (archives: IArchives) => Promise<T>): Promise<T> {
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
        return await this.request({}, archives => archives.get2(fileName, config));
    }
    public async getInfo(fileName: string): Promise<{ writeTime: number; size: number } | undefined> {
        return await this.request({}, archives => archives.getInfo(fileName));
    }
    public async find(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<string[]> {
        return await this.request({ apiOnly: true }, archives => archives.find(prefix, config));
    }
    public async findInfo(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        return await this.request({ apiOnly: true }, archives => archives.findInfo(prefix, config));
    }
    public async getChangesAfter(time: number): Promise<ArchiveFileInfo[]> {
        return await this.request({ apiOnly: true }, async archives => {
            if (!archives.getChangesAfter) {
                throw new Error(`${archives.getDebugName()} does not support getChangesAfter`);
            }
            return await archives.getChangesAfter(time);
        });
    }
    public async getSyncStatus(): Promise<ArchivesSyncStatus> {
        return await this.request({ apiOnly: true }, async archives => {
            if (!archives.getSyncStatus) {
                throw new Error(`${archives.getDebugName()} does not support getSyncStatus`);
            }
            return await archives.getSyncStatus();
        });
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
            if (source.config.syncOptions?.noWriteBack) continue;
            if (!await source.hasWriteAccess()) return false;
        }
        return true;
    }

    public async set(fileName: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
        await this.request({ write: true }, archives => archives.set(fileName, data, config));
    }
    public async del(fileName: string): Promise<void> {
        await this.request({ write: true }, archives => archives.del(fileName));
    }
    public async setLargeFile(config: { path: string; getNextData(): Promise<Buffer | undefined> }): Promise<void> {
        let state = await this.getState();
        for (let source of state.sources) {
            if (source.config.syncOptions?.noWriteBack) continue;
            if (!source.isConnected()) {
                source.noteFailure();
                continue;
            }
            // The data stream cannot be rewound, so there is no failover once the upload starts
            return await source.write(archives => archives.setLargeFile(config));
        }
        throw new Error(`No available source for setLargeFile on ${this.getDebugName()}`);
    }

    public async getURL(path: string): Promise<string> {
        let state = await this.getState();
        for (let source of state.sources) {
            if (source.config.public === false) continue;
            if (source.url) return await source.url.getURL(path);
            if (source.api) return await source.api.getURL(path);
        }
        throw new Error(`No public source to build a URL from for ${this.getDebugName()} (every source has public: false)`);
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
