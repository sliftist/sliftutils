module.allowclient = true;

import { RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig } from "../IArchives";

// Parsing / normalization of RemoteConfig (see IArchives.ts). Every bucket stores its own
// configuration (a RemoteConfig) inside itself, at ROUTING_FILE. Writing that file creates the
// bucket / reconfigures it (see storageServerState.ts); clients reconcile it by version (see
// createArchives.ts).

export const ROUTING_FILE = "storage/storagerouting.json";
const ROUTING_SUFFIX = "/" + ROUTING_FILE;

// A missing version counts as -1, so any explicitly versioned config beats an unversioned one
export function getConfigVersion(config: RemoteConfig): number {
    return config.version ?? -1;
}

/** Strips the routing-file suffix, leaving the bucket's public base URL (file paths append to it). */
export function getBucketBaseUrl(url: string): string {
    if (!url.endsWith(ROUTING_SUFFIX)) {
        throw new Error(`Expected a bucket routing URL ending with ${JSON.stringify(ROUTING_SUFFIX)}, was ${JSON.stringify(url)}`);
    }
    return url.slice(0, -ROUTING_SUFFIX.length);
}

export function buildFileUrl(baseUrl: string, filePath: string): string {
    return baseUrl + "/" + filePath.split("/").map(encodeURIComponent).join("/");
}

// Ex: https://storage2.vidgridweb.com:4445/file/exampleaccount/examplebucket/storage/storagerouting.json
export function parseHostedUrl(url: string): { address: string; port: number; account: string; bucketName: string } {
    let base = getBucketBaseUrl(url);
    let u = new URL(base);
    if (u.protocol !== "https:") {
        throw new Error(`Storage URL must use https, got ${JSON.stringify(u.protocol)} in ${JSON.stringify(url)}`);
    }
    let parts = u.pathname.split("/").filter(x => x);
    if (parts.length !== 3 || parts[0] !== "file") {
        throw new Error(`Expected a hosted bucket URL like https://host:port/file/<account>/<bucketName>${ROUTING_SUFFIX}, was ${JSON.stringify(url)}`);
    }
    return { address: u.hostname, port: +u.port || 443, account: decodeURIComponent(parts[1]), bucketName: decodeURIComponent(parts[2]) };
}

// Ex: https://f002.backblazeb2.com/file/querysubtest-com-public-immutable/storage/storagerouting.json
export function parseBackblazeUrl(url: string): { bucketName: string } {
    let base = getBucketBaseUrl(url);
    let u = new URL(base);
    let parts = u.pathname.split("/").filter(x => x);
    if (parts.length !== 2 || parts[0] !== "file") {
        throw new Error(`Expected a backblaze bucket URL like https://f002.backblazeb2.com/file/<bucketName>${ROUTING_SUFFIX}, was ${JSON.stringify(url)}`);
    }
    return { bucketName: decodeURIComponent(parts[1]) };
}

export function normalizeSource(source: RemoteConfigBase): HostedConfig | BackblazeConfig {
    if (typeof source !== "string") {
        if (source.type === "remote") {
            // Throws if the URL is malformed, so bad configs are rejected before they're stored
            parseHostedUrl(source.url);
        }
        return source;
    }
    let hostname = new URL(source).hostname;
    if (hostname.endsWith(".backblazeb2.com")) {
        // Validates the URL (throws on malformed) before it's stored; the bucket name is read back
        // out of the URL at use sites, never stored on the config.
        parseBackblazeUrl(source);
        return { type: "backblaze", url: source };
    }
    parseHostedUrl(source);
    return { type: "remote", url: source };
}

export function normalizeRemoteConfig(config: RemoteConfig | RemoteConfigBase): RemoteConfig {
    let result: RemoteConfig;
    if (typeof config !== "string" && "sources" in config) {
        result = { version: config.version, sources: config.sources.map(normalizeSource) };
    } else {
        result = { sources: [normalizeSource(config)] };
    }
    // Mixed immutability makes no sense: a mutable source would accept overwrites that the
    // immutable sources then refuse to synchronize, permanently forking their contents
    let sources = result.sources.map(normalizeSource);
    let immutableCount = sources.filter(x => x.immutable).length;
    if (immutableCount && immutableCount !== sources.length) {
        throw new Error(`If any source is immutable, all must be immutable: ${immutableCount} of ${sources.length} sources are. Sources: ${JSON.stringify(sources.map(x => ({ url: x.url, immutable: !!x.immutable })))}`);
    }
    return result;
}

export function parseRoutingData(data: Buffer): RemoteConfig {
    let text = data.toString();
    let parsed: RemoteConfig;
    try {
        parsed = JSON.parse(text) as RemoteConfig;
    } catch (e) {
        throw new Error(`Routing config is not valid JSON (${String(e)}). Data: ${text.slice(0, 500)}`);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sources)) {
        throw new Error(`Routing config must be { version?, sources: [...] }, was ${text.slice(0, 500)}`);
    }
    return normalizeRemoteConfig(parsed);
}

export function serializeRemoteConfig(config: RemoteConfig): Buffer {
    return Buffer.from(JSON.stringify(config, undefined, 4));
}
