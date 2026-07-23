/// <reference types="node" />
/// <reference types="node" />
import { ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, ChangesAfterConfig } from "../IArchives";
import { ServerBucketInfo, ActiveBucketInfo } from "./storageServerState";
import { AccessTotals, AccessSummaryState } from "./accessStats";
import type { SummaryEntry } from "../../treeSummary";
export declare const REMOTE_STORAGE_CLASS_GUID = "RemoteStorageController-b7e42a91";
export declare const STORAGE_AUTH_PURPOSE = "remoteStorage-auth-1";
export declare const STORAGE_NOT_AUTHENTICATED = "REMOTE_STORAGE_NOT_AUTHENTICATED_cf2f7b1e";
export declare const STORAGE_ACCESS_DENIED = "REMOTE_STORAGE_ACCESS_DENIED_9d81a4c0";
export type AuthTokenData = {
    purpose: string;
    time: number;
    server: string;
};
export type AuthToken = {
    certPem: string;
    signature: string;
    data: AuthTokenData;
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
export declare function broadcastRoutingChanged(): void;
export declare const RemoteStorageController: import("socket-function/SocketFunctionTypes").SocketRegistered<{
    ping: () => Promise<{}>;
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
    adminListActiveBuckets: () => Promise<{
        account: string;
        bucketName: string;
    }[]>;
    adminListRequests: (ip: string) => Promise<AccessRequest[]>;
    adminGrantAccess: (requestId: string) => Promise<TrustRecord>;
    get: (account: string, bucketName: string, path: string, range?: {
        start: number;
        end: number;
    }) => Promise<Buffer | undefined>;
    get2: (account: string, bucketName: string, path: string, range?: {
        start: number;
        end: number;
    }, internal?: boolean) => Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
    } | undefined>;
    set: (account: string, bucketName: string, path: string, data: Buffer, lastModified?: number, forceSetImmutable?: boolean, internal?: boolean) => Promise<void>;
    del: (account: string, bucketName: string, path: string, lastModified?: number, internal?: boolean) => Promise<void>;
    getInfo: (account: string, bucketName: string, path: string, includeTombstones?: boolean) => Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo: (account: string, bucketName: string, prefix: string, config?: {
        shallow?: boolean;
        type?: "files" | "folders";
    }) => Promise<ArchiveFileInfo[]>;
    getChangesAfter2: (account: string, bucketName: string, config: ChangesAfterConfig) => Promise<ArchiveFileInfo[]>;
    getArchivesConfig: (account: string, bucketName: string) => Promise<ArchivesConfig>;
    listBuckets: (account: string) => Promise<ServerBucketInfo[]>;
    getActiveBucket: (account: string, bucketName: string) => Promise<ActiveBucketInfo | string>;
    activateBucket: (account: string, bucketName: string) => Promise<ActiveBucketInfo | string>;
    clearWriteStats: (account: string) => Promise<{
        clearedBuckets: number;
    }>;
    getAccessStats: (account: string) => Promise<AccessTotals>;
    getAccessSummaries: (account: string, config: {
        operation: string;
        maxCount: number;
        weightBySize?: boolean;
    }) => Promise<SummaryEntry<AccessSummaryState>[]>;
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
    startLargeFile: (account: string, bucketName: string, path: string, lastModified?: number) => Promise<string>;
    uploadPart: (uploadId: string, data: Buffer) => Promise<void>;
    finishLargeFile: (uploadId: string) => Promise<void>;
    cancelLargeFile: (uploadId: string) => Promise<void>;
    httpEntry: (config?: {
        requireCalls?: string[];
        cacheTime?: number;
    }) => Promise<Buffer>;
}>;
