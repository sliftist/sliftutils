module.allowclient = true;

import fs from "fs";
import os from "os";
import { isNode } from "socket-function/src/misc";
import {
    IArchives, RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig,
    ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus,
} from "../IArchives";
import {
    ROUTING_FILE, getConfigVersion, getBucketBaseUrl, parseHostedUrl,
    normalizeRemoteConfig, normalizeSource, parseRoutingData, serializeRemoteConfig,
} from "./remoteConfig";
import { ArchivesRemote } from "./ArchivesRemote";
import { ArchivesUrl } from "./ArchivesUrl";
import { ArchivesBackblaze } from "../backblaze";
import { getStorageServerConfigOptional, getLocalArchives } from "./storageServerState";
import { STORAGE_ACCESS_DENIED } from "./storageController";

// Turns a RemoteConfig into a usable IArchives (createArchives). Setup is fully lazy: on the first
// call we read the routing file (ROUTING_FILE) from every source, adopt the newest version found
// (exactly ONE level of indirection - we never fetch routing configs from newly adopted sources),
// and write the adopted config to every source that is missing it (which CREATES not-yet-existing
// buckets) or holds an older version.

const DOWN_RETRY_DELAY = 30 * 1000;
const ENSURE_RETRY_DELAY = 30 * 1000;

// The direct API IArchives for one source, with no URL-form fallback and no chaining. Used by the
// storage server for its synchronization sources: hosted sources block waiting for account access
// (logging instructions) when access hasn't been granted yet.
export function createApiArchives(source: HostedConfig | BackblazeConfig): IArchives {
    if (source.type === "backblaze") {
        return new ArchivesBackblaze({ bucketName: source.bucketName, public: source.public, immutable: source.immutable });
    }
    let parsed = parseHostedUrl(source.url);
    let server = isNode() && getStorageServerConfigOptional() || undefined;
    if (server && parsed.address === server.domain && parsed.port === server.port) {
        // This source is a bucket hosted by our own process - use it directly instead of calling
        // ourselves over HTTPS
        return getLocalArchives(parsed.account, parsed.bucketName);
    }
    return new ArchivesRemote({ url: source.url, accountName: source.accountName });
}

function hasBackblazeCreds(): boolean {
    return isNode() && fs.existsSync(os.homedir() + "/backblaze.json");
}

type ChainSource = {
    config: HostedConfig | BackblazeConfig;
    // Direct API access. Missing when we can only use the public-URL form (backblaze without
    // credentials, or backblaze in the browser).
    api?: IArchives;
    // Public-URL fallback, used when the API denies us access. Never created when the config
    // explicitly says public: false (then we don't even hit the URL).
    url?: ArchivesUrl;
    // Why writes to this source can never work (collected into the error when a write finds no
    // source that accepts it)
    writeBlocked?: string;
    // After a source errors we stop trying it until this time, so one down source doesn't stall
    // every call
    downUntil: number;
    // Whether we confirmed this source holds an up-to-date routing file. Writing that file creates
    // the bucket, so this also tracks which buckets we've initialized.
    routingEnsured: boolean;
    lastEnsureAttempt: number;
};

function buildChainSource(config: HostedConfig | BackblazeConfig): ChainSource {
    let source: ChainSource = { config, downUntil: 0, routingEnsured: false, lastEnsureAttempt: 0 };
    if (config.type === "backblaze") {
        if (hasBackblazeCreds()) {
            source.api = new ArchivesBackblaze({ bucketName: config.bucketName, public: config.public, immutable: config.immutable });
        } else if (isNode()) {
            source.writeBlocked = `No backblaze credentials for ${config.url}. Create ~/backblaze.json with { "applicationKeyId": ..., "applicationKey": ... } to enable API access.`;
        } else {
            source.writeBlocked = `Browsers cannot write to backblaze (bucket ${config.url})`;
        }
        if (!source.api && config.public !== false) {
            source.url = new ArchivesUrl(getBucketBaseUrl(config.url));
        }
        return source;
    }
    let parsed = parseHostedUrl(config.url);
    let server = isNode() && getStorageServerConfigOptional() || undefined;
    if (server && parsed.address === server.domain && parsed.port === server.port) {
        // A bucket hosted by our own process - use it directly instead of calling ourselves
        source.api = getLocalArchives(parsed.account, parsed.bucketName);
        return source;
    }
    source.api = new ArchivesRemote({ url: config.url, accountName: config.accountName, waitForAccess: false });
    if (config.public !== false) {
        source.url = new ArchivesUrl(getBucketBaseUrl(config.url));
    }
    return source;
}

export class ArchivesChain implements IArchives {
    private normalized: RemoteConfig;
    // The config we operate on: ours, or a newer-versioned one adopted from a source's routing file
    private adopted: RemoteConfig;
    private sourcesPromise: Promise<ChainSource[]> | undefined;

    constructor(config: RemoteConfig | RemoteConfigBase) {
        this.normalized = normalizeRemoteConfig(config);
        this.adopted = this.normalized;
    }

    public getDebugName() {
        let urls = this.adopted.sources.map(x => typeof x === "string" && x || (x as HostedConfig | BackblazeConfig).url);
        return `chain/${urls.join(",")}`;
    }

    private getSourceConfigs(config: RemoteConfig): (HostedConfig | BackblazeConfig)[] {
        return config.sources.map(normalizeSource);
    }

    private getSources(): Promise<ChainSource[]> {
        if (!this.sourcesPromise) {
            let promise = this.init();
            this.sourcesPromise = promise;
            // A failed init isn't cached, so a source coming up later fixes us
            promise.catch(() => {
                if (this.sourcesPromise === promise) {
                    this.sourcesPromise = undefined;
                }
            });
        }
        return this.sourcesPromise;
    }

    private async init(): Promise<ChainSource[]> {
        let sources = this.getSourceConfigs(this.normalized).map(buildChainSource);
        let fetched = await Promise.all(sources.map(async source => {
            try {
                let data = await this.readFromSource(source, archives => archives.get(ROUTING_FILE));
                return data && parseRoutingData(data) || undefined;
            } catch {
                // Down or access denied - ensureRouting retries reconciliation for this source later
                return undefined;
            }
        }));
        let best = this.normalized;
        for (let config of fetched) {
            if (config && getConfigVersion(config) > getConfigVersion(best)) {
                best = config;
            }
        }
        this.adopted = best;
        if (best !== this.normalized) {
            // Exactly one level of indirection: the adopted config's sources are used directly,
            // and we never fetch routing configs from THEM to adopt something newer again
            sources = this.getSourceConfigs(best).map(buildChainSource);
            await Promise.all(sources.map(source => this.ensureRouting(source)));
            return sources;
        }
        for (let i = 0; i < sources.length; i++) {
            let config = fetched[i];
            if (config && getConfigVersion(config) >= getConfigVersion(best)) {
                sources[i].routingEnsured = true;
            }
        }
        await Promise.all(sources.map((source, i) => this.ensureRouting(source, { known: { existing: fetched[i] } })));
        return sources;
    }

    // Makes sure a source holds our adopted routing config, creating the bucket when it doesn't
    // exist yet (a bucket exists iff its routing file does) and upgrading older versions. Failures
    // (no access, source down) are swallowed - we retry periodically, and actual writes surface
    // the real error.
    private async ensureRouting(source: ChainSource, config?: { known?: { existing: RemoteConfig | undefined }; force?: boolean }): Promise<void> {
        if (source.routingEnsured) return;
        if (!config?.force && source.lastEnsureAttempt !== 0 && Date.now() - source.lastEnsureAttempt < ENSURE_RETRY_DELAY) return;
        source.lastEnsureAttempt = Date.now();
        let known = config?.known;
        try {
            let existing = known && known.existing;
            if (!known) {
                let data = await this.readFromSource(source, archives => archives.get(ROUTING_FILE));
                existing = data && parseRoutingData(data) || undefined;
            }
            if (existing && getConfigVersion(existing) >= getConfigVersion(this.adopted)) {
                source.routingEnsured = true;
                return;
            }
            if (!source.api) return;
            await source.api.set(ROUTING_FILE, serializeRemoteConfig(this.adopted));
            source.routingEnsured = true;
        } catch { }
    }

    // Reads from one source, API first, falling back to the public-URL form when the API denies us
    // access. Access-denied does NOT mark the source down (access can be granted at any moment);
    // genuine failures do.
    private async readFromSource<T>(source: ChainSource, run: (archives: IArchives) => Promise<T>): Promise<T> {
        if (source.api) {
            try {
                return await run(source.api);
            } catch (e) {
                let denied = String((e as Error).stack || e).includes(STORAGE_ACCESS_DENIED);
                if (!denied) {
                    source.downUntil = Date.now() + DOWN_RETRY_DELAY;
                    throw e;
                }
                if (!source.url) throw e;
            }
        }
        if (!source.url) {
            throw new Error(`Source ${source.config.url} has no API access and no public URL form (public: false)`);
        }
        try {
            return await run(source.url);
        } catch (e) {
            source.downUntil = Date.now() + DOWN_RETRY_DELAY;
            throw e;
        }
    }

    // Tries each source in turn, skipping recently-down ones. A source that answers - even with
    // undefined / empty - is authoritative: sources are synchronized copies of the same bucket, so
    // a miss on one is a miss everywhere (we don't scan the rest).
    private async read<T>(config: { apiOnly?: boolean }, run: (archives: IArchives) => Promise<T>): Promise<T> {
        let sources = await this.getSources();
        let errors: string[] = [];
        for (let source of sources) {
            if (source.downUntil > Date.now()) {
                errors.push(`${source.config.url} is down, retrying after ${new Date(source.downUntil).toISOString()}`);
                continue;
            }
            // Opportunistic (even on reads): create the bucket / upgrade its routing where needed
            void this.ensureRouting(source);
            if (config.apiOnly) {
                let api = source.api;
                if (!api) {
                    errors.push(`${source.config.url} has URL-only access, which cannot serve this operation`);
                    continue;
                }
                try {
                    return await run(api);
                } catch (e) {
                    if (!String((e as Error).stack || e).includes(STORAGE_ACCESS_DENIED)) {
                        source.downUntil = Date.now() + DOWN_RETRY_DELAY;
                    }
                    errors.push(String(e));
                    continue;
                }
            }
            try {
                return await this.readFromSource(source, run);
            } catch (e) {
                errors.push(String(e));
            }
        }
        throw new Error(`All sources failed for ${this.getDebugName()}: ${errors.join(" | ")}`);
    }

    private getAccessHelp(source: ChainSource): string {
        if (source.config.type === "remote") {
            let parsed = parseHostedUrl(source.config.url);
            let account = source.config.accountName || parsed.account;
            return `No write access to account ${JSON.stringify(account)} on ${parsed.address}:${parsed.port}. Visit https://${parsed.address}:${parsed.port}/${account} to grant this machine access.`;
        }
        return `Write to ${source.config.url} was denied (check the ~/backblaze.json credentials)`;
    }

    // Writes go to the first source that accepts them - the storage servers synchronize the
    // sources between themselves. If no source accepts the write, the error explains how to get
    // write access (the access page link, or the backblaze secret to create).
    private async write(run: (archives: IArchives) => Promise<void>): Promise<void> {
        let sources = await this.getSources();
        let errors: string[] = [];
        for (let source of sources) {
            if (source.config.syncOptions?.noWriteBack) continue;
            if (source.writeBlocked) {
                errors.push(source.writeBlocked);
                continue;
            }
            let api = source.api;
            if (!api) continue;
            if (source.downUntil > Date.now()) {
                errors.push(`${source.config.url} is down, retrying after ${new Date(source.downUntil).toISOString()}`);
                continue;
            }
            // The write needs the bucket to exist, so this one is awaited (and never throttled)
            await this.ensureRouting(source, { force: true });
            try {
                return await run(api);
            } catch (e) {
                if (String((e as Error).stack || e).includes(STORAGE_ACCESS_DENIED)) {
                    errors.push(this.getAccessHelp(source));
                } else {
                    source.downUntil = Date.now() + DOWN_RETRY_DELAY;
                    errors.push(String(e));
                }
            }
        }
        throw new Error(`Write failed on every source of ${this.getDebugName()}: ${errors.join(" | ") || "no sources accept writes"}`);
    }

    // The access-page link (plus our machineId/ip, for the approver to match the request) for the
    // first hosted source that hasn't granted us access. undefined when we have access everywhere
    // we can have it. Also registers the access request server-side.
    public async waitingForAccess(): Promise<{ link: string; machineId: string; ip: string } | undefined> {
        let sources = await this.getSources();
        for (let source of sources) {
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
    public async get2(fileName: string, config?: { range?: { start: number; end: number } }): Promise<{ data: Buffer; writeTime: number } | undefined> {
        return await this.read({}, archives => archives.get2(fileName, config));
    }
    public async getInfo(fileName: string): Promise<{ writeTime: number; size: number } | undefined> {
        return await this.read({}, archives => archives.getInfo(fileName));
    }
    public async find(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<string[]> {
        return await this.read({ apiOnly: true }, archives => archives.find(prefix, config));
    }
    public async findInfo(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        return await this.read({ apiOnly: true }, archives => archives.findInfo(prefix, config));
    }
    public async getChangesAfter(time: number): Promise<ArchiveFileInfo[]> {
        return await this.read({ apiOnly: true }, async archives => {
            if (!archives.getChangesAfter) {
                throw new Error(`${archives.getDebugName()} does not support getChangesAfter`);
            }
            return await archives.getChangesAfter(time);
        });
    }
    public async getSyncStatus(): Promise<ArchivesSyncStatus> {
        return await this.read({ apiOnly: true }, async archives => {
            if (!archives.getSyncStatus) {
                throw new Error(`${archives.getDebugName()} does not support getSyncStatus`);
            }
            return await archives.getSyncStatus();
        });
    }
    public async getConfig(): Promise<ArchivesConfig> {
        let sources = await this.getSources();
        if (!sources.some(x => x.api)) return {};
        return await this.read({ apiOnly: true }, archives => archives.getConfig());
    }

    public async set(fileName: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
        await this.write(archives => archives.set(fileName, data, config));
    }
    public async del(fileName: string): Promise<void> {
        await this.write(archives => archives.del(fileName));
    }
    public async setLargeFile(config: { path: string; getNextData(): Promise<Buffer | undefined> }): Promise<void> {
        let sources = await this.getSources();
        let errors: string[] = [];
        for (let source of sources) {
            if (source.config.syncOptions?.noWriteBack) continue;
            if (source.writeBlocked) {
                errors.push(source.writeBlocked);
                continue;
            }
            if (!source.api) continue;
            if (source.downUntil > Date.now()) {
                errors.push(`${source.config.url} is down, retrying after ${new Date(source.downUntil).toISOString()}`);
                continue;
            }
            await this.ensureRouting(source, { force: true });
            // The data stream cannot be rewound, so there is no failover to later sources here
            return await source.api.setLargeFile(config);
        }
        throw new Error(`No writable source for setLargeFile on ${this.getDebugName()}: ${errors.join(" | ") || "no sources accept writes"}`);
    }

    public async getURL(path: string): Promise<string> {
        let sources = await this.getSources();
        for (let source of sources) {
            if (source.config.public === false) continue;
            if (source.url) return await source.url.getURL(path);
            if (source.api) return await source.api.getURL(path);
        }
        throw new Error(`No public source to build a URL from for ${this.getDebugName()} (every source has public: false)`);
    }
}

// The IArchives for a RemoteConfig (or a single source - a routing URL string works). Fully lazy:
// nothing is contacted until the first call.
export function createArchives(config: RemoteConfig | RemoteConfigBase): ArchivesChain {
    return new ArchivesChain(config);
}
