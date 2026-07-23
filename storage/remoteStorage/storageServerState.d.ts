/// <reference types="node" />
/// <reference types="node" />
import { IBucketStore } from "./blobStore";
import { RemoteConfig, HostedConfig, IArchives, ArchivesConfig } from "../IArchives";
import type { IStorage } from "../IStorage";
import type { AccessRequest, TrustRecord } from "./storageController";
export type StorageServerConfig = {
    domain: string;
    port: number;
    rootDomain: string;
    sshTarget: string;
    serverCommand: string;
    folder: string;
};
export declare function setStorageServerConfig(value: StorageServerConfig): void;
export declare function getStorageServerConfig(): StorageServerConfig;
export declare function getStorageServerConfigOptional(): StorageServerConfig | undefined;
export declare function setWritesRejectedReason(reason: string | undefined): void;
export declare function getWritesRejectedReason(): string | undefined;
export declare function assertWritesAllowed(): void;
export declare function getTrust(): Promise<IStorage<TrustRecord>>;
export declare function getRequests(): Promise<IStorage<AccessRequest[]>>;
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
export declare function setTrustedMachines(config: {
    account: string;
    machineIds: string[];
}): Promise<void>;
export type LoadedBucket = {
    account: string;
    bucketName: string;
    routing: RemoteConfig;
    routingJSON: string;
    selfEntries: HostedConfig[];
    self: SelfSummary | undefined;
    store: IBucketStore;
    structureKey: string;
};
export declare function addExtraListenPort(port: number): void;
export declare function removeExtraListenPort(port: number): void;
/** Whether address:port is this server process. The ONE self test - findSelfIndexes, createApiArchives, and SourceWrapper all consult it, so "is this me" cannot disagree between the routing plan and connection building: a URL that is us on an extra listen port must never become a network client to ourselves, which is how infinite self-request loops form. */
export declare function isOwnAddress(address: string, port: number): boolean;
/** A cached IArchives for a persisted source identity: a routing URL (hosted/backblaze) or a disk folder path - the form BlobStore's sources list stores. Configuration (valid windows, routes) decides WHEN a source should be used; for reading bytes the index says a source holds, the URL alone is enough - even for sources no longer in any config. */
export declare function resolveSourceArchives(url: string): IArchives;
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
export declare function getLoadedBucket(account: string, bucketName: string): Promise<LoadedBucket | undefined>;
export declare function assertMutable(bucket: LoadedBucket, filePath: string, writeTime: number): Promise<void>;
export declare function writeBucketFile(account: string, bucketName: string, filePath: string, data: Buffer, config?: {
    lastModified?: number;
    forceSetImmutable?: boolean;
    internal?: boolean;
}): Promise<void>;
export declare function getBucketConfig(bucket: LoadedBucket): ArchivesConfig;
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
export type BucketDiskInfo = {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
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
export declare function deleteBucketFile(account: string, bucketName: string, filePath: string): Promise<void>;
export declare function getLocalArchives(account: string, bucketName: string): IArchives;
