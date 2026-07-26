import { RemoteConfig, HostedConfig, SourceConfig } from "../IArchives";
/** Whether a config entry is THIS server's copy of this bucket - the same account and bucket, at an address this process answers on. */
export declare function isSelfSource(source: SourceConfig, account: string, bucketName: string): boolean;
export declare function findSelfIndexes(routing: RemoteConfig, account: string, bucketName: string): number[];
export declare function selectEntryAt(entries: HostedConfig[], time: number, route?: number): HostedConfig | undefined;
/** What one of our stores has to pull in at a valid-window boundary, so the writes that landed just before the handover are not missed. */
export type BoundaryHandover = {
    name: string;
    route: [number, number];
    scanOwnDisk: boolean;
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
export declare function previousWindowOwners(config: RemoteConfig, windowStart: number, selfIndexes: number[]): BoundaryHandover[];
