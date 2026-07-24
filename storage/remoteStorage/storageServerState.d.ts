/// <reference types="node" />
/// <reference types="node" />
import { IBucketStore } from "./blobStore";
import { RemoteConfig, HostedConfig, SourceConfig, IArchives, ArchivesConfig, ArchivesSyncStatus } from "../IArchives";
import { BucketDiskInfo } from "./bucketDisk";
import { SelfSummary } from "./storePlan";
export type LoadedStore = {
    routeKey: string;
    route?: [number, number];
    entries: HostedConfig[];
    folder: string;
    store: IBucketStore;
};
export type BucketState = {
    account: string;
    bucketName: string;
    routing: RemoteConfig;
    routingJSON: string;
    selfEntries: HostedConfig[];
    self: SelfSummary | undefined;
    stores: LoadedStore[];
    structureKey: string;
};
/** The loaded bucket, loading it (which instantiates its stores and starts their synchronization) if needed. A bucket that does not exist on this server throws - callers never see undefined buckets. */
export declare function requireBucket(account: string, bucketName: string): Promise<BucketState>;
/** The store serving a request: the exact config entry the CLIENT selected, matched by equality (key order ignored) against the bucket's own entries. A match is honored even when its window has passed - the selection never validates, the store's own validation throws instead. Throws when nothing matches, listing what is available. */
export declare function findBucketStore(account: string, bucketName: string, sourceConfig: SourceConfig | undefined): Promise<LoadedStore>;
/** Internal (store-to-store) reads skip store selection entirely: the caller is another store whose index says this MACHINE holds the bytes - the persisted holder identity is just a URL, which cannot name a store. Whichever store's folder has the newest copy answers. */
export declare function readBucketInternal(account: string, bucketName: string, config: {
    path: string;
    range?: {
        start: number;
        end: number;
    };
    includeTombstones?: boolean;
}): Promise<{
    data: Buffer;
    writeTime: number;
    size: number;
} | undefined>;
export declare function getBucketConfig(bucket: BucketState): ArchivesConfig;
export declare function bucketSyncStatus(bucket: BucketState): Promise<ArchivesSyncStatus>;
export declare function bucketIndexTotals(bucket: BucketState): Promise<{
    fileCount: number;
    byteCount: number;
    sources: {
        debugName: string;
        fileCount: number;
        byteCount: number;
    }[];
} | undefined>;
/** A cached IArchives for a persisted source identity: a routing URL (hosted/backblaze) or a disk folder path - the form BlobStore's sources list stores. Configuration (valid windows, routes) decides WHEN a source should be used; for reading bytes the index says a source holds, the URL alone is enough - even for sources no longer in any config. */
export declare function resolveSourceArchives(url: string): IArchives;
export declare function getLoadedBucket(account: string, bucketName: string): Promise<BucketState | undefined>;
/** The routing-config write path - the ONE write that cannot go through a store (it is what CREATES the bucket and its stores). Serialized per bucket: concurrent config writes would race the version check. */
export declare function queueRoutingConfigWrite(account: string, bucketName: string, data: Buffer, config?: {
    lastModified?: number;
}): Promise<void>;
/** Which buckets this process currently has loaded - what a deploy successor asks its predecessor for, so it activates exactly the buckets that are actually in use. */
export declare function getActiveBucketKeys(): {
    account: string;
    bucketName: string;
}[];
export declare function rebuildAllLoadedBuckets(): Promise<void>;
/** Started by deployTakeover once we are actually a deploy successor listening on an alternate port. Until then there are no switchover windows to write or expire, so nothing polls. */
export declare const startIntermediateMaintenance: {
    (): void;
    reset(): void;
    set(newValue: void): void;
};
export type ServerBucketInfo = {
    bucketName: string;
    active: boolean;
    /** Where the bucket's data lives on this server */
    folder: string;
    /** The drive that folder is on. Buckets sharing a drive report the same numbers. */
    disk?: BucketDiskInfo;
    diskError?: string;
    writeStats?: BucketWriteStats;
    config?: ArchivesConfig;
    error?: string;
};
export type ActiveBucketInfo = {
    folder: string;
    /** The routing config the bucket is RUNNING on, straight from memory - including switchover windows written since it loaded */
    routing: RemoteConfig;
    /** Our own entries in that config, and their summarized current role (routes union + flags) */
    selfEntries: HostedConfig[];
    self?: SelfSummary;
    config: ArchivesConfig;
};
/** The live in-memory state of ONE bucket, answered without touching the disk (no routing file read, no statfs, no stored write stats). Returns an error string when the bucket is not loaded here, which is the normal state for a bucket nothing has accessed since startup. */
export declare function getActiveBucket(account: string, bucketName: string): Promise<ActiveBucketInfo | string>;
/** Loads a bucket that exists on this server's disk into memory, which starts its synchronization and window timers, and returns its live state. Nothing is written and no other server is contacted - unlike building an ArchivesChain for it, which would probe every source and could write the routing config. Already-loaded buckets just return their state. */
export declare function activateBucket(account: string, bucketName: string): Promise<ActiveBucketInfo | string>;
export declare function listAccountBuckets(account: string): Promise<ServerBucketInfo[]>;
export type BucketWriteStats = {
    /** Every set call the bucket accepted */
    originalWrites: number;
    originalBytes: number;
    /** What actually reached the sources. Fast writes coalesce repeated writes to the same key, so this is lower than the original counts (and is what the disk actually did). */
    flushedWrites: number;
    flushedBytes: number;
};
/** Zeroes the write statistics of every bucket in the account. */
export declare function clearAccountWriteStats(account: string): number;
export declare function getLocalArchives(account: string, bucketName: string, sourceConfig: SourceConfig): IArchives;
