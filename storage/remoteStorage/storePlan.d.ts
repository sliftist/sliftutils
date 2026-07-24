import { RemoteConfig, HostedConfig, SourceConfig } from "../IArchives";
export declare function findSelfIndexes(routing: RemoteConfig, account: string, bucketName: string): number[];
export declare function selectEntryAt(entries: HostedConfig[], time: number, route?: number): HostedConfig | undefined;
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
export type StoreSourceSpec = {
    sourceConfig?: SourceConfig;
    validWindow: [number, number];
    route?: [number, number];
    noFullSync?: boolean;
};
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
export declare function computeStorePlan(account: string, bucketName: string, routing: RemoteConfig): StorePlan;
