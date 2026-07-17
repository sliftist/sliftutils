/// <reference types="node" />
/// <reference types="node" />
import { IBucketStore } from "./blobStore";
import { RemoteConfig, HostedConfig, IArchives } from "../IArchives";
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
export type LoadedBucket = {
    account: string;
    bucketName: string;
    routing: RemoteConfig;
    routingJSON: string;
    self: HostedConfig | undefined;
    store: IBucketStore;
};
export declare function getLoadedBucket(account: string, bucketName: string): Promise<LoadedBucket | undefined>;
export declare function assertMutable(bucket: LoadedBucket, filePath: string): Promise<void>;
export declare function writeBucketFile(account: string, bucketName: string, filePath: string, data: Buffer, config?: {
    lastModified?: number;
}): Promise<void>;
export declare function deleteBucketFile(account: string, bucketName: string, filePath: string): Promise<void>;
export declare function getLocalArchives(account: string, bucketName: string): IArchives;
