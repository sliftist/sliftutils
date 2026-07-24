import { sort } from "socket-function/src/misc";
import { RemoteConfig, HostedConfig, SourceConfig, FULL_ROUTE } from "../IArchives";
import { parseHostedUrl, routeContains, routeIntersection } from "./remoteConfig";
import { isOwnAddress } from "./serverConfig";

// Turns a bucket's routing config into this server's store plan: which of the entries are us, what stores (one per route) we run, and which peers each store synchronizes from.

export function findSelfIndexes(routing: RemoteConfig, account: string, bucketName: string): number[] {
    let indexes: number[] = [];
    for (let i = 0; i < routing.sources.length; i++) {
        let source = routing.sources[i];
        if (typeof source === "string" || source.type !== "remote") continue;
        let parsed = parseHostedUrl(source.url);
        if (parsed.account !== account || parsed.bucketName !== bucketName) continue;
        if (isOwnAddress(parsed.address, parsed.port)) {
            indexes.push(i);
        }
    }
    return indexes;
}

export function selectEntryAt(entries: HostedConfig[], time: number, route?: number): HostedConfig | undefined {
    if (route !== undefined) {
        let covering = entries.filter(x => routeContains(x.route, route));
        if (covering.length) {
            entries = covering;
        }
    }
    let containing = entries.find(x => x.validWindow[0] <= time && time < x.validWindow[1]);
    if (containing) return containing;
    let best: HostedConfig | undefined;
    let bestDistance = Infinity;
    for (let entry of entries) {
        let distance = Math.min(Math.abs(time - entry.validWindow[0]), Math.abs(time - entry.validWindow[1]));
        if (distance < bestDistance) {
            bestDistance = distance;
            best = entry;
        }
    }
    return best;
}

/** Our role in a bucket's routing config, summarized across ALL currently-valid self entries. Stored instead of a single representative HostedConfig, so nothing can accidentally use one entry's route or flags where the union is required - the standard config has the same URL twice: a routed write-shard entry plus an unrouted read-everything entry. */
export type SelfSummary = {
    /** The union of the current entries' routes, with overlapping/adjacent ranges combined - which commonly collapses to a single full range, making matching trivial. */
    routes: [number, number][];
    public: boolean;
    immutable: boolean;
    noFullSync: boolean;
    rawDisk: boolean;
    readerDiskLimit?: number;
};

function mergeRoutes(routes: ([number, number] | undefined)[]): [number, number][] {
    let list = routes.map(x => x || FULL_ROUTE).map(x => [x[0], x[1]] as [number, number]);
    sort(list, x => x[0]);
    let merged: [number, number][] = [];
    for (let route of list) {
        let last = merged[merged.length - 1];
        if (last && route[0] <= last[1]) {
            last[1] = Math.max(last[1], route[1]);
            continue;
        }
        merged.push(route);
    }
    return merged;
}

function summarizeSelf(selfEntries: HostedConfig[], now: number): SelfSummary | undefined {
    let current = selfEntries.filter(x => x.validWindow[0] <= now && now < x.validWindow[1]);
    if (!current.length) {
        let nearest = selectEntryAt(selfEntries, now);
        current = nearest && [nearest] || [];
    }
    if (!current.length) {
        return undefined;
    }
    return {
        routes: mergeRoutes(current.map(x => x.route)),
        public: current.some(x => x.public),
        immutable: current.some(x => x.immutable),
        noFullSync: current.some(x => x.noFullSync),
        rawDisk: current.some(x => x.rawDisk),
        readerDiskLimit: current.find(x => x.readerDiskLimit !== undefined)?.readerDiskLimit,
    };
}

export type StoreSourceSpec = { sourceConfig?: SourceConfig; validWindow: [number, number]; route?: [number, number]; noFullSync?: boolean };
export type StorePlanStore = {
    routeKey: string;
    route?: [number, number];
    entries: HostedConfig[];
    rawDisk: boolean;
    readerDiskLimit?: number;
    sourceSpecs: StoreSourceSpec[];
};
export type StorePlan = {
    selfEntries: HostedConfig[];
    self: SelfSummary | undefined;
    stores: StorePlanStore[];
    structureKey: string;
};

export function computeStorePlan(account: string, bucketName: string, routing: RemoteConfig): StorePlan {
    let selfIndexes = findSelfIndexes(routing, account, bucketName);
    let selfEntries = selfIndexes.map(i => routing.sources[i] as HostedConfig);
    let self = summarizeSelf(selfEntries, Date.now());
    let ownIndexes = new Set(selfIndexes);
    // One store per distinct route among ALL our entries - past and future windows included, so historical route folders keep serving their data and upcoming routes sync ahead of their window
    let groups = new Map<string, { route?: [number, number]; entries: HostedConfig[]; firstIndex: number }>();
    for (let i of selfIndexes) {
        let entry = routing.sources[i] as HostedConfig;
        let routeKey = JSON.stringify(entry.route || FULL_ROUTE);
        let group = groups.get(routeKey);
        if (!group) {
            group = { route: entry.route, entries: [], firstIndex: i };
            groups.set(routeKey, group);
        }
        group.entries.push(entry);
    }
    let stores: StorePlanStore[] = [];
    for (let [routeKey, group] of groups) {
        let anchor = selectEntryAt(group.entries, Date.now());
        let diskWindow: [number, number] = [0, 0];
        if (anchor) {
            let [start, end] = anchor.validWindow;
            let merged = true;
            while (merged) {
                merged = false;
                for (let entry of group.entries) {
                    let [entryStart, entryEnd] = entry.validWindow;
                    if (entryStart > end || entryEnd < start) continue;
                    if (entryStart < start || entryEnd > end) {
                        start = Math.min(start, entryStart);
                        end = Math.max(end, entryEnd);
                        merged = true;
                    }
                }
            }
            diskWindow = [start, end];
        }
        let sourceSpecs: StoreSourceSpec[] = [{ validWindow: diskWindow }];
        let noFullSync = group.entries.some(x => x.noFullSync);
        for (let i = group.firstIndex + 1; i < routing.sources.length; i++) {
            let source = routing.sources[i];
            if (typeof source === "string" || ownIndexes.has(i)) continue;
            let sharedRoute = routeIntersection(group.route, source.route);
            if (!sharedRoute) continue;
            sourceSpecs.push({ sourceConfig: source, validWindow: source.validWindow, route: sharedRoute, noFullSync: source.noFullSync || noFullSync });
        }
        stores.push({
            routeKey,
            route: group.route,
            entries: group.entries,
            rawDisk: group.entries.some(x => x.rawDisk),
            readerDiskLimit: group.entries.find(x => x.readerDiskLimit !== undefined)?.readerDiskLimit,
            sourceSpecs,
        });
    }
    if (!stores.length) {
        // Not in the config at all: still serve whatever the plain folder holds, through one inert full-route store
        stores.push({ routeKey: JSON.stringify(FULL_ROUTE), route: undefined, entries: [], rawDisk: false, readerDiskLimit: undefined, sourceSpecs: [{ validWindow: [0, 0] }] });
    }
    let structureKey = JSON.stringify(stores.map(s => ({ routeKey: s.routeKey, rawDisk: s.rawDisk, readerDiskLimit: s.readerDiskLimit })));
    return { selfEntries, self, stores, structureKey };
}
