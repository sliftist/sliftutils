import { sort } from "socket-function/src/misc";
import { getBufferInt } from "socket-function/src/bits";
import { setFlag } from "socket-function/require/compileFlags";
import jsSha256 from "js-sha256";
import { RemoteConfig, RemoteConfigBase, SourceConfig, ArchiveFileInfo, ChangesAfterConfig, FULL_VALID_WINDOW, FULL_ROUTE, VARIABLE_SHARD } from "../IArchives";
import { assertValidSourceName } from "./validation";

setFlag(require, "js-sha256", "allowclient", true);

// Parsing / normalization of RemoteConfig (see IArchives.ts). Every bucket stores its own configuration (a RemoteConfig) inside itself, at ROUTING_FILE. Writing that file creates the bucket / reconfigures it (see storageServerState.ts); clients reconcile it by version (see createArchives.ts).

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
    // Pure JS, so routing works clientside too (node's crypto hashing is unavailable there)
    let hash = getBufferInt(Buffer.from(jsSha256.sha256.array(key)));
    return hash % ROUTE_PRECISION / ROUTE_PRECISION;
}

/** The in-memory getChangesAfter2 emulation, for backends without a native change feed: a full listing filtered down to files written after config.time whose keys route into config.routes. */
export function filterChanges(files: ArchiveFileInfo[], config: ChangesAfterConfig): ArchiveFileInfo[] {
    return files.filter(file => {
        if (file.createTime <= config.time) return false;
        let routes = config.routes;
        if (routes && !routes.some(route => routeContains(route, getRoute(file.path)))) return false;
        return true;
    });
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

/**
 * Puts a source into the shape the code expects. It does NOT judge it: this runs every time a config
 * is READ, and a config that is already on disk has to keep working - a server that cannot parse its
 * own routing file is a server that cannot serve, and it would stay that way forever. Anything
 * missing or unusable is filled in with the safest equivalent instead, loudly where it matters.
 *
 * Judging happens on the way IN, in assertValidRemoteConfig.
 */
export function normalizeSource(source: RemoteConfigBase): SourceConfig {
    if (typeof source !== "string") {
        let normalized = { ...source };
        // Configs written before names existed have none, and a name that could not be a folder cannot be used as one. Both get the derived name: deterministic, so every server picks the same one for the same entry.
        if (!isUsableSourceName(normalized.name)) {
            let derived = derivedSourceName(normalized);
            if (normalized.name !== undefined) {
                console.error(`Source name ${JSON.stringify(normalized.name)} in a routing config cannot be used as a folder name, so this entry is being read as ${JSON.stringify(derived)}: ${JSON.stringify(source).slice(0, 500)}`);
            }
            normalized.name = derived;
        }
        let window = normalized.validWindow;
        if (!Array.isArray(window) || window.length !== 2 || !window.every(x => typeof x === "number")) {
            console.error(`Source ${JSON.stringify(normalized.name)} has no usable validWindow (${JSON.stringify(window)}), reading it as always valid: ${JSON.stringify(source).slice(0, 500)}`);
            normalized.validWindow = FULL_VALID_WINDOW;
        }
        let route = normalized.route;
        if (route !== undefined && !isUsableRoute(route)) {
            console.error(`Source ${JSON.stringify(normalized.name)} has an unusable route (${JSON.stringify(route)}), reading it as the whole key space: ${JSON.stringify(source).slice(0, 500)}`);
            normalized.route = undefined;
        }
        return normalized;
    }
    let hostname = new URL(source).hostname;
    if (hostname.endsWith(".backblazeb2.com")) {
        // Validates the URL (throws on malformed) before it's stored; the bucket name is read back out of the URL at use sites, never stored on the config.
        let parsed = parseBackblazeUrl(source);
        return { type: "backblaze", url: source, name: sanitizeSourceName(parsed.bucketName), validWindow: FULL_VALID_WINDOW, public: true };
    }
    let parsed = parseHostedUrl(source);
    return { type: "remote", url: source, name: sanitizeSourceName(`${parsed.address}-${parsed.port}`), validWindow: FULL_VALID_WINDOW, public: true };
}

function isUsableSourceName(name: string | undefined): boolean {
    if (!name) return false;
    try {
        assertValidSourceName(name);
        return true;
    } catch {
        return false;
    }
}

function isUsableRoute(route: [number, number]): boolean {
    if (!Array.isArray(route) || route.length !== 2 || !route.every(x => typeof x === "number")) return false;
    return route[0] >= 0 && route[1] <= 1 && route[0] < route[1];
}

/** The name an entry gets when it has no usable one of its own: the endpoint it points at, plus its route when it has one - so entries that were distinct storage before names existed stay distinct now. */
function derivedSourceName(source: SourceConfig): string {
    let endpoint = source.url;
    if (source.type === "remote") {
        let parsed = parseHostedUrl(source.url);
        endpoint = `${parsed.address}-${parsed.port}`;
    } else {
        endpoint = parseBackblazeUrl(source.url).bucketName;
    }
    let route = source.route;
    if (route && isUsableRoute(route) && !(route[0] === FULL_ROUTE[0] && route[1] === FULL_ROUTE[1])) {
        endpoint += `-route-${route[0]}-${route[1]}`;
    }
    return sanitizeSourceName(endpoint);
}

/** A name built from something that was never meant to be one (a host, a bucket), made usable as a folder. Periods survive, so it still reads as what it came from. */
function sanitizeSourceName(from: string): string {
    let name = from.replace(/[^\w.-]/g, "-").slice(0, 64);
    if (!isUsableSourceName(name)) {
        // Only reachable from something with no usable characters at all; the name still has to exist
        return "source";
    }
    return name;
}

/** How far up from 0 the sources' routes reach without a gap (1 means the whole key space). */
function getRouteCoverage(sources: SourceConfig[]): number {
    let routes = sources.map(x => x.route || FULL_ROUTE);
    sort(routes, x => x[0]);
    let covered = 0;
    for (let route of routes) {
        if (route[0] > covered) break;
        covered = Math.max(covered, route[1]);
    }
    return covered;
}

/** Puts a whole config into the shape the code expects, without judging it - see normalizeSource, and see assertValidRemoteConfig for the judging. */
export function normalizeRemoteConfig(config: RemoteConfig | RemoteConfigBase): RemoteConfig {
    if (typeof config !== "string" && "sources" in config) {
        return { version: config.version, sources: config.sources.map(normalizeSource) };
    }
    return { sources: [normalizeSource(config)] };
}

/**
 * Whether a config may be WRITTEN. Everything here is a rule about the config as a whole, which is
 * exactly why it cannot run on read: a config that is already stored somewhere has to keep being
 * readable, or a server that once accepted a bad one could never start again. Rejecting it at the
 * point it is introduced is what keeps a bad one from ever being stored in the first place.
 */
export function assertValidRemoteConfig(config: RemoteConfig): void {
    let sources = config.sources.map(normalizeSource);
    // Mixed immutability makes no sense AMONG sources valid at the same time: a mutable source would accept overwrites that its immutable peers refuse to synchronize, forking their contents. Sources are grouped by transitively overlapping valid windows (absorb everything overlapping the group, extend the group's end, repeat) - a soft check that is correct as long as windows have clean breaks (a group ends exactly where the next begins).
    let sorted = [...sources];
    sort(sorted, x => x.validWindow[0]);
    let group: typeof sources = [];
    let groupEnd = 0;
    function checkGroup() {
        let immutableCount = group.filter(x => x.immutable).length;
        if (immutableCount && immutableCount !== group.length) {
            throw new Error(`Sources with overlapping valid windows must agree on immutability: ${immutableCount} of ${group.length} are immutable. Sources: ${JSON.stringify(group.map(x => ({ url: x.url, validWindow: x.validWindow, immutable: !!x.immutable })))}`);
        }
        // The sources valid at any instant must cover the whole key space, or keys routing into a gap could never be read
        let covered = getRouteCoverage(group);
        if (covered < 1) {
            throw new Error(`Sources with overlapping valid windows must cover the full route space [0, 1); coverage stops at ${covered}. Sources: ${JSON.stringify(group.map(x => ({ url: x.url, validWindow: x.validWindow, route: x.route || FULL_ROUTE })))}`);
        }
        // A store is NOT required to cover the whole key space on its own. It once was, because a store that holds keys outside the route it synchronizes never learns of their deletions and eventually resurrects them - but a store's data now lives under its name rather than its route, and a scan only ever indexes keys inside the route the store is configured for, so keys outside it are never taken into the index that could resurrect them. What replaces that rule is the naming discipline: a name is one storage, and pointing a name at a different route later is what would hand it keys it never synchronized.
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
    // ONE entry per store at any instant. A name is a store - one folder, one index - so two entries naming it at the same time would be two answers to "what is this store configured to be right now", and every route and flag it reads would depend on which entry you happened to look at. Non-overlapping windows are fine, and are how a store's configuration changes over time.
    for (let i = 0; i < sources.length; i++) {
        for (let j = i + 1; j < sources.length; j++) {
            let a = sources[i];
            let b = sources[j];
            if (storeIdentity(a) !== storeIdentity(b)) continue;
            if (a.validWindow[0] < b.validWindow[1] && b.validWindow[0] < a.validWindow[1]) {
                throw new Error(`The name ${JSON.stringify(a.name)} is reused with multiple source configurations at the same time:\n    ${JSON.stringify(a)}\n    ${JSON.stringify(b)}\nA name is one store - one folder, one index - so it can only be configured one way at a time. Give them non-overlapping valid windows, or different names if they are meant to be different storage.`);
            }
        }
    }
}

/**
 * The identity of one of a store's SOURCE SLOTS - which is the endpoint it talks to, and not the same
 * question as which store this is (that is CommonConfig.name). A switchover's alternate port is a
 * distinct slot even though it names the same storage, because a slot holds a connection to a port.
 *
 * ONLY the type, the url, and the intermediate's alternate port are part of it: everything else is
 * policy about how we USE the endpoint, and changing policy must never make a store believe it is
 * looking at a NEW source - that would drop every index entry the old one held and rescan it from
 * scratch, so the files it holds go missing from listings until the rescan finishes, for a flag flip.
 *
 * Built by hand rather than by serializing the config, so it cannot change just because the routing
 * file was written with its keys in a different order.
 */
export function sourceIdentity(sourceConfig: SourceConfig | undefined): string {
    if (!sourceConfig) return "disk";
    return `${sourceConfig.type}|${sourceConfig.url}|${sourceConfig.intermediate || ""}`;
}

/** What an index entry records as the holder of its bytes (see ArchivesSource.url), so it must name the endpoint FOREVER. An intermediate is a switchover's temporary alternate port onto another source, and that port is gone for good once its window passes - so it is recorded as the source it was split out of, which holds the same bucket and outlives it. */
export function sourcePersistentUrl(sourceConfig: SourceConfig | undefined, folder: string): string {
    if (!sourceConfig) return folder;
    return sourceConfig.intermediate || sourceConfig.url;
}

/** Which store an entry configures: its name, on the server it points at. A switchover's alternate port is the same server (so it is compared against the entry it was split out of, whose window it must not overlap); a genuinely different server with the same name is a different store, on a different machine. */
function storeIdentity(source: SourceConfig): string {
    return `${source.intermediate || source.url}|${source.name}`;
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
