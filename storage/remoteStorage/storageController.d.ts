/// <reference types="node" />
/// <reference types="node" />
import { ArchiveFileInfo } from "../IArchives";
import type { BlobStore } from "./blobStore";
import type { IStorage } from "../IStorage";
export declare const REMOTE_STORAGE_CLASS_GUID = "RemoteStorageController-b7e42a91";
export declare const STORAGE_AUTH_PURPOSE = "remoteStorage-auth-1";
export declare const STORAGE_NOT_AUTHENTICATED = "REMOTE_STORAGE_NOT_AUTHENTICATED_cf2f7b1e";
export declare const STORAGE_ACCESS_DENIED = "REMOTE_STORAGE_ACCESS_DENIED_9d81a4c0";
export type AuthToken = {
    certPem: string;
    time: number;
    signature: string;
};
export type AccessRequest = {
    requestId: string;
    account: string;
    machineId: string;
    ip: string;
    time: number;
};
export type TrustRecord = {
    account: string;
    machineId: string;
    ip: string;
    time: number;
};
export type BucketConfig = {
    folder: string;
    public?: boolean;
    fast?: boolean;
    writeDelay?: number;
};
export type AccessState = {
    machineId: string;
    ip: string;
    hasAccess: boolean;
    grantAccessCommand?: string;
    trustedMachines?: TrustRecord[];
};
export type StorageServerState = {
    domain: string;
    port: number;
    rootDomain: string;
    sshTarget: string;
    serverCommand: string;
    getBlobStore(bucket: BucketConfig): BlobStore;
    trust: IStorage<TrustRecord>;
    requests: IStorage<AccessRequest[]>;
    buckets: IStorage<BucketConfig>;
};
export declare function setStorageServerState(state: StorageServerState): void;
export declare function setWritesRejectedReason(reason: string | undefined): void;
export declare const RemoteStorageController: import("socket-function/SocketFunctionTypes").SocketRegistered<{
    authenticate: (token: AuthToken) => Promise<{
        machineId: string;
        ip: string;
    }>;
    requestAccess: (account: string) => Promise<{
        machineId: string;
        ip: string;
        requestId: string;
        grantAccessCommand: string;
    }>;
    getAccessState: (account: string) => Promise<AccessState>;
    listRequestsForIP: (account: string, ip: string) => Promise<AccessRequest[]>;
    grantAccess: (requestId: string) => Promise<TrustRecord>;
    adminListRequests: (ip: string) => Promise<AccessRequest[]>;
    adminGrantAccess: (requestId: string) => Promise<TrustRecord>;
    ensureBucket: (account: string, bucketName: string, config: Omit<BucketConfig, "folder">) => Promise<void>;
    get: (account: string, bucketName: string, path: string, range?: {
        start: number;
        end: number;
    }) => Promise<Buffer | undefined>;
    set: (account: string, bucketName: string, path: string, data: Buffer) => Promise<void>;
    del: (account: string, bucketName: string, path: string) => Promise<void>;
    getInfo: (account: string, bucketName: string, path: string) => Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo: (account: string, bucketName: string, prefix: string, config?: {
        shallow?: boolean;
        type?: "files" | "folders";
    }) => Promise<ArchiveFileInfo[]>;
    startLargeFile: (account: string, bucketName: string, path: string) => Promise<string>;
    uploadPart: (uploadId: string, data: Buffer) => Promise<void>;
    finishLargeFile: (uploadId: string) => Promise<void>;
    cancelLargeFile: (uploadId: string) => Promise<void>;
    getPublicFile: (account: string, bucketName: string, path: string) => Promise<Buffer>;
}>;
