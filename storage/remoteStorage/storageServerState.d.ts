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
/** Makes machineIds the complete trust list for the account: machines not in the list lose access, machines already trusted keep their existing record, and missing ones are added. */
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
export declare function getLoadedBucket(account: string, bucketName: string): Promise<LoadedBucket | undefined>;
export declare function setRoutingChangedBroadcaster(broadcaster: () => void): void;
export declare function assertMutable(bucket: LoadedBucket, filePath: string, writeTime: number): Promise<void>;
export declare function writeBucketFile(account: string, bucketName: string, filePath: string, data: Buffer, config?: {
    lastModified?: number;
}): Promise<void>;
export declare function getBucketConfig(bucket: LoadedBucket): ArchivesConfig;
export declare function rebuildAllLoadedBuckets(): Promise<void>;
export type ServerBucketInfo = {
    bucketName: string;
    active: boolean;
    config?: ArchivesConfig;
    error?: string;
};
/** Every bucket the account has on this server, active or not, each with its configuration.
 *  Inactive buckets are inspected straight from disk WITHOUT loading them - loading would start
 *  their synchronization, and old invalid buckets must stay inert (their parse error is reported
 *  instead). */
export declare function listAccountBuckets(account: string): Promise<ServerBucketInfo[]>;
export declare function deleteBucketFile(account: string, bucketName: string, filePath: string): Promise<void>;
export declare function getLocalArchives(account: string, bucketName: string): IArchives;
