module.allowclient = true;

import { sort, sha256HashBuffer } from "socket-function/src/misc";
import { getBufferInt } from "socket-function/src/bits";
import { RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig, FULL_VALID_WINDOW, FULL_ROUTE, VARIABLE_SHARD } from "../IArchives";

// Parsing / normalization of RemoteConfig (see IArchives.ts). Every bucket stores its own
// configuration (a RemoteConfig) inside itself, at ROUTING_FILE. Writing that file creates the
// bucket / reconfigures it (see storageServerState.ts); clients reconcile it by version (see
// createArchives.ts).

export const ROUTING_FILE = "storage/storagerouting.json";
const ROUTING_SUFFIX = "/" + ROUTING_FILE;

const ROUTE_PRECISION = 1000 * 1000 * 1000;

/** The variable-shard route override embedded in the key ("<sentinel>_<value>", see VARIABLE_SHARD), or undefined when the key has no sentinel or the sentinel has no value yet. */
export function parseVariableRoute(key: string): number | undefined {
    let index = key.indexOf(VARIABLE_SHARD);
    if (index === -1) return undefined;
    let match = /^_(\d+(?:\.\d+)?)/.exec(key.slice(index + VARIABLE_SHARD.length));
    if (!match) return undefined;
    return +match[1];
}

/** Where a key routes in [0, 1). A materialized variable-shard suffix completely overrides the hash. */
export function getRoute(key: string): number {
    let override = parseVariableRoute(key);
    if (override !== undefined) return override;
    let hash = getBufferInt(sha256HashBuffer(key));
    return hash % ROUTE_PRECISION / ROUTE_PRECISION;
}

// Route ranges are [start, end) - inclusive start, exclusive end
export function routeContains(route: [number, number] | undefined, value: number): boolean {
    if (!route) return true;
    return route[0] <= value && value < route[1];
}
export function routesOverlap(a: [number, number] | undefined, b: [number, number] | undefined): boolean {
    let [aStart, aEnd] = a || FULL_ROUTE;
    let [bStart, bEnd] = b || FULL_ROUTE;
    return aStart < bEnd && bStart < aEnd;
}
/** The overlap of two route ranges, or undefined when they don't overlap. */
export function routeIntersection(a: [number, number] | undefined, b: [number, number] | undefined): [number, number] | undefined {
    let [aStart, aEnd] = a || FULL_ROUTE;
    let [bStart, bEnd] = b || FULL_ROUTE;
    let start = Math.max(aStart, bStart);
    let end = Math.min(aEnd, bEnd);
    if (start >= end) return undefined;
    return [start, end];
}

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

export function replaceHostedUrlPort(url: string, port: number): string {
    let u = new URL(url);
    u.port = String(port);
    return u.toString();
}

export function normalizeSource(source: RemoteConfigBase): HostedConfig | BackblazeConfig {
    if (typeof source !== "string") {
        let window = source.validWindow;
        if (!Array.isArray(window) || window.length !== 2 || !window.every(x => typeof x === "number")) {
            throw new Error(`Object source configs must specify validWindow ([startMs, endMs] of the write times the source is valid for) - configuration changes must be scheduled, not flipped instantly. Use FULL_VALID_WINDOW when the source is always valid. Was ${JSON.stringify(window)} on ${JSON.stringify(source).slice(0, 500)}`);
        }
        let route = source.route;
        if (route !== undefined && (!Array.isArray(route) || route.length !== 2 || !route.every(x => typeof x === "number") || route[0] < 0 || route[1] > 1 || route[0] >= route[1])) {
            throw new Error(`Source route must be a [start, end) fraction range within [0, 1] with start < end, was ${JSON.stringify(route)} on ${JSON.stringify(source).slice(0, 500)}`);
        }
        if (source.readerDiskLimit !== undefined) {
            if (typeof source.readerDiskLimit !== "number" || source.readerDiskLimit <= 0) {
                throw new Error(`readerDiskLimit must be a positive byte count, was ${JSON.stringify(source.readerDiskLimit)} on ${JSON.stringify(source).slice(0, 500)}`);
            }
            if (!source.noFullSync) {
                throw new Error(`readerDiskLimit requires noFullSync: a full copy cannot be bounded, only a read cache can. On ${JSON.stringify(source).slice(0, 500)}`);
            }
        }
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
        return { type: "backblaze", url: source, validWindow: FULL_VALID_WINDOW };
    }
    parseHostedUrl(source);
    return { type: "remote", url: source, validWindow: FULL_VALID_WINDOW };
}

export function normalizeRemoteConfig(config: RemoteConfig | RemoteConfigBase): RemoteConfig {
    let result: RemoteConfig;
    if (typeof config !== "string" && "sources" in config) {
        result = { version: config.version, sources: config.sources.map(normalizeSource) };
    } else {
        result = { sources: [normalizeSource(config)] };
    }
    // Mixed immutability makes no sense AMONG sources valid at the same time: a mutable source
    // would accept overwrites that its immutable peers refuse to synchronize, forking their
    // contents. Sources are grouped by transitively overlapping valid windows (absorb everything
    // overlapping the group, extend the group's end, repeat) - a soft check that is correct as
    // long as windows have clean breaks (a group ends exactly where the next begins).
    let sources = result.sources.map(normalizeSource);
    let sorted = [...sources];
    sort(sorted, x => x.validWindow[0]);
    let group: typeof sources = [];
    let groupEnd = 0;
    function checkGroup() {
        let immutableCount = group.filter(x => x.immutable).length;
        if (immutableCount && immutableCount !== group.length) {
            throw new Error(`Sources with overlapping valid windows must agree on immutability: ${immutableCount} of ${group.length} are immutable. Sources: ${JSON.stringify(group.map(x => ({ url: x.url, validWindow: x.validWindow, immutable: !!x.immutable })))}`);
        }
        // The sources valid at any instant must cover the whole key space, or keys routing into a
        // gap could never be read
        let routes = group.map(x => x.route || FULL_ROUTE);
        sort(routes, x => x[0]);
        let covered = 0;
        for (let route of routes) {
            if (route[0] > covered) break;
            covered = Math.max(covered, route[1]);
        }
        if (covered < 1) {
            throw new Error(`Sources with overlapping valid windows must cover the full route space [0, 1); coverage stops at ${covered}. Sources: ${JSON.stringify(group.map(x => ({ url: x.url, validWindow: x.validWindow, route: x.route || FULL_ROUTE })))}`);
        }
    }
    for (let source of sorted) {
        if (group.length && source.validWindow[0] >= groupEnd) {
            checkGroup();
            group = [];
        }
        group.push(source);
        groupEnd = Math.max(groupEnd, source.validWindow[1]);
    }
    checkGroup();
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
