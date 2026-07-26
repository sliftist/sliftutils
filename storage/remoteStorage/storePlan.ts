import { RemoteConfig, HostedConfig, SourceConfig, FULL_ROUTE } from "../IArchives";
import { parseHostedUrl, routeContains, routeIntersection } from "./remoteConfig";
import { isOwnAddress } from "./serverConfig";

// Pure helpers over a bucket's routing config: which entries are this server, which entry applies at a moment, and who owned what before a window boundary. Config in, answer out - nothing here reads a store, a clock, or the network (except selectEntryAt being handed a time).

/** Whether a config entry is THIS server's copy of this bucket - the same account and bucket, at an address this process answers on. */
export function isSelfSource(source: SourceConfig, account: string, bucketName: string): boolean {
    if (source.type !== "remote") return false;
    let parsed = parseHostedUrl(source.url);
    if (parsed.account !== account || parsed.bucketName !== bucketName) return false;
    return isOwnAddress(parsed.address, parsed.port);
}

export function findSelfIndexes(routing: RemoteConfig, account: string, bucketName: string): number[] {
    let indexes: number[] = [];
    for (let i = 0; i < routing.sources.length; i++) {
        let source = routing.sources[i];
        if (typeof source === "string") continue;
        if (isSelfSource(source, account, bucketName)) {
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

/** The parts of `ranges` that `cut` does not cover, plus the single range spanning what it did. Routes are half-open [start, end), so subtracting one from another leaves at most a piece on each side. */
function subtractRoute(ranges: [number, number][], cut: [number, number]): { remaining: [number, number][]; claimed?: [number, number] } {
    let remaining: [number, number][] = [];
    let claimed: [number, number] | undefined;
    for (let range of ranges) {
        let overlap = routeIntersection(range, cut);
        if (!overlap) {
            remaining.push(range);
            continue;
        }
        claimed = claimed && [Math.min(claimed[0], overlap[0]), Math.max(claimed[1], overlap[1])] as [number, number] || overlap;
        if (range[0] < overlap[0]) remaining.push([range[0], overlap[0]]);
        if (overlap[1] < range[1]) remaining.push([overlap[1], range[1]]);
    }
    return { remaining, claimed };
}

/** What one of our stores has to pull in at a valid-window boundary, so the writes that landed just before the handover are not missed. */
export type BoundaryHandover = {
    // The store that needs the data: the name of the self entry taking over at the boundary
    name: string;
    // The route it is taking over, which is the slice of the key space the pulls below are limited to
    route: [number, number];
    // We held part of this route in the previous window too, so those writes are already in our own folder and a disk rescan finds them
    scanOwnDisk: boolean;
    // Per source index in the config, the slice of our route THAT source held in the previous window - a boundary scan pulls its recent changes
    remotes: Map<number, [number, number]>;
};

/**
 * Who held each slice of our route in the window before windowStart, for every self entry whose
 * window starts exactly then. This is the whole of "who do we take over from": a store taking over a
 * route may be taking it from several previous owners at once (their shards need not line up with
 * ours), and from itself for the parts it already held.
 *
 * A self entry is skipped when an EARLIER entry valid at the boundary already covers its whole route:
 * config order is priority, so that entry is the write target and we are not the one taking over.
 * Owners are then resolved in config order too, each claiming the part of our route still unclaimed -
 * the same first-match-wins rule that picks a write target at any other moment.
 *
 * Pure: config in, plan out. Nothing here reads a store, a clock, or the network.
 */
export function previousWindowOwners(config: RemoteConfig, windowStart: number, selfIndexes: number[]): BoundaryHandover[] {
    let selfIndexSet = new Set(selfIndexes);
    let previousTime = windowStart - 1;
    let validAt = (source: SourceConfig, time: number) => source.validWindow[0] <= time && time < source.validWindow[1];
    let byRoute = new Map<string, BoundaryHandover>();
    for (let selfIndex of selfIndexes) {
        let self = config.sources[selfIndex];
        if (typeof self === "string" || self.validWindow[0] !== windowStart) continue;
        let selfRoute = self.route || FULL_ROUTE;
        let shadowed = false;
        for (let i = 0; i < selfIndex; i++) {
            let other = config.sources[i];
            if (typeof other === "string" || !validAt(other, windowStart)) continue;
            let route = other.route || FULL_ROUTE;
            if (route[0] <= selfRoute[0] && selfRoute[1] <= route[1]) {
                shadowed = true;
                break;
            }
        }
        if (shadowed) continue;
        // Keyed by both: one name can take over several routes at the same boundary, and each is pulled separately
        let handoverKey = `${self.name}|${JSON.stringify(selfRoute)}`;
        let handover = byRoute.get(handoverKey);
        if (!handover) {
            handover = { name: self.name, route: selfRoute, scanOwnDisk: false, remotes: new Map() };
            byRoute.set(handoverKey, handover);
        }
        let unclaimed: [number, number][] = [[selfRoute[0], selfRoute[1]]];
        for (let i = 0; i < config.sources.length && unclaimed.length; i++) {
            let other = config.sources[i];
            if (typeof other === "string" || !validAt(other, previousTime)) continue;
            let { remaining, claimed } = subtractRoute(unclaimed, other.route || FULL_ROUTE);
            unclaimed = remaining;
            if (!claimed) continue;
            if (selfIndexSet.has(i)) {
                handover.scanOwnDisk = true;
                continue;
            }
            let existing = handover.remotes.get(i);
            handover.remotes.set(i, existing && [Math.min(existing[0], claimed[0]), Math.max(existing[1], claimed[1])] as [number, number] || claimed);
        }
    }
    return [...byRoute.values()].filter(x => x.scanOwnDisk || x.remotes.size);
}

