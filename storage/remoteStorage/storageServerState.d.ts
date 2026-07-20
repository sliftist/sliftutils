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
/** Zeroes the write statistics of every bucket in the account, including counts not yet flushed. */
export declare function clearAccountWriteStats(account: string): Promise<number>;
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
    self: HostedConfig | undefined;
    store: IBucketStore;
    structureKey: string;
};
export declare function addExtraListenPort(port: number): void;
export declare function removeExtraListenPort(port: number): void;
export declare function getLoadedBucket(account: string, bucketName: string): Promise<LoadedBucket | undefined>;
export declare function assertMutable(bucket: LoadedBucket, filePath: string, writeTime: number): Promise<void>;
export declare function writeBucketFile(account: string, bucketName: string, filePath: string, data: Buffer, config?: {
    lastModified?: number;
}): Promise<void>;
export declare function getBucketConfig(bucket: LoadedBucket): ArchivesConfig;
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
export declare function listAccountBuckets(account: string): Promise<ServerBucketInfo[]>;
export declare function deleteBucketFile(account: string, bucketName: string, filePath: string): Promise<void>;
export declare function getLocalArchives(account: string, bucketName: string): IArchives;
