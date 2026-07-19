/// <reference types="node" />
/// <reference types="node" />
import { ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus } from "../IArchives";
import { ServerBucketInfo } from "./storageServerState";
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
export type AccessState = {
    machineId: string;
    ip: string;
    hasAccess: boolean;
    grantAccessCommand?: string;
    trustedMachines?: TrustRecord[];
};
export declare const RemoteStorageController: import("socket-function/SocketFunctionTypes").SocketRegistered<{
    ping: () => Promise<{
        takeover?: string;
    }>;
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
    get: (account: string, bucketName: string, path: string, range?: {
        start: number;
        end: number;
    }) => Promise<Buffer | undefined>;
    get2: (account: string, bucketName: string, path: string, range?: {
        start: number;
        end: number;
    }) => Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
    } | undefined>;
    set: (account: string, bucketName: string, path: string, data: Buffer, lastModified?: number) => Promise<void>;
    del: (account: string, bucketName: string, path: string) => Promise<void>;
    getInfo: (account: string, bucketName: string, path: string) => Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo: (account: string, bucketName: string, prefix: string, config?: {
        shallow?: boolean;
        type?: "files" | "folders";
    }) => Promise<ArchiveFileInfo[]>;
    getChangesAfter: (account: string, bucketName: string, time: number) => Promise<ArchiveFileInfo[]>;
    getArchivesConfig: (account: string, bucketName: string) => Promise<ArchivesConfig>;
    listBuckets: (account: string) => Promise<ServerBucketInfo[]>;
    getIndexInfo: (account: string, bucketName: string) => Promise<{
        fileCount: number;
        byteCount: number;
        sources: {
            debugName: string;
            fileCount: number;
            byteCount: number;
        }[];
    } | undefined>;
    getSyncStatus: (account: string, bucketName: string) => Promise<ArchivesSyncStatus>;
    startLargeFile: (account: string, bucketName: string, path: string) => Promise<string>;
    uploadPart: (uploadId: string, data: Buffer) => Promise<void>;
    finishLargeFile: (uploadId: string) => Promise<void>;
    cancelLargeFile: (uploadId: string) => Promise<void>;
    httpEntry: (config?: {
        requireCalls?: string[];
        cacheTime?: number;
    }) => Promise<Buffer>;
}>;
