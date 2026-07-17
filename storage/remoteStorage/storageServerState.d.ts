import { IBucketStore } from "./blobStore";
import type { IStorage } from "../IStorage";
import type { AccessRequest, TrustRecord, BucketConfig } from "./storageController";
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
export declare function setWritesRejectedReason(reason: string | undefined): void;
export declare function getWritesRejectedReason(): string | undefined;
export declare function getTrust(): Promise<IStorage<TrustRecord>>;
export declare function getRequests(): Promise<IStorage<AccessRequest[]>>;
export declare function getBuckets(): Promise<IStorage<BucketConfig>>;
export declare function getBlobStore(bucket: BucketConfig): IBucketStore;
