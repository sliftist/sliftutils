/// <reference types="node" />
/// <reference types="node" />
import { ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, FindConfig, SourceConfig } from "../IArchives";
import { ActiveBucketInfo, ServerBucketInfo } from "./storageServerState";
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
    requestAccess: (config: {
        account: string;
    }) => Promise<{
        machineId: string;
        ip: string;
        requestId: string;
        grantAccessCommand: string;
    }>;
    getAccessState: (config: {
        account: string;
    }) => Promise<AccessState>;
    listRequestsForIP: (config: {
        account: string;
        ip: string;
    }) => Promise<AccessRequest[]>;
    grantAccess: (config: {
        requestId: string;
    }) => Promise<TrustRecord>;
    adminListActiveBuckets: () => Promise<{
        account: string;
        bucketName: string;
    }[]>;
    adminListRequests: (config: {
        ip: string;
    }) => Promise<AccessRequest[]>;
    adminGrantAccess: (config: {
        requestId: string;
    }) => Promise<TrustRecord>;
    get2: (config: {
        account: string;
        bucketName: string;
        path: string;
        sourceConfig: SourceConfig;
        range?: {
            start: number;
            end: number;
        };
        internal?: boolean;
        includeTombstones?: boolean;
    }) => Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
    } | undefined>;
    set: (config: {
        account: string;
        bucketName: string;
        path: string;
        data: Buffer;
        sourceConfig: SourceConfig;
        lastModified?: number;
        forceSetImmutable?: boolean;
        internal?: boolean;
    }) => Promise<void>;
    del: (config: {
        account: string;
        bucketName: string;
        path: string;
        sourceConfig: SourceConfig;
        lastModified?: number;
        internal?: boolean;
    }) => Promise<void>;
    getInfo: (config: {
        account: string;
        bucketName: string;
        path: string;
        sourceConfig: SourceConfig;
        includeTombstones?: boolean;
    }) => Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo: (config: FindConfig & {
        account: string;
        bucketName: string;
        prefix: string;
        sourceConfig: SourceConfig;
    }) => Promise<ArchiveFileInfo[]>;
    getChangesAfter2: (config: {
        account: string;
        bucketName: string;
        sourceConfig: SourceConfig;
        time: number;
        routes?: [number, number][];
    }) => Promise<ArchiveFileInfo[]>;
    getArchivesConfig: (config: {
        account: string;
        bucketName: string;
    }) => Promise<ArchivesConfig>;
    listBuckets: (config: {
        account: string;
    }) => Promise<ServerBucketInfo[]>;
    getActiveBucket: (config: {
        account: string;
        bucketName: string;
    }) => Promise<ActiveBucketInfo | string>;
    activateBucket: (config: {
        account: string;
        bucketName: string;
    }) => Promise<ActiveBucketInfo | string>;
    clearWriteStats: (config: {
        account: string;
    }) => Promise<{
        clearedBuckets: number;
    }>;
    getAccessStats: (config: {
        account: string;
    }) => Promise<AccessTotals>;
    getAccessSummaries: (config: {
        account: string;
        operation: string;
        maxCount: number;
        weightBySize?: boolean;
    }) => Promise<SummaryEntry<AccessSummaryState>[]>;
    getIndexInfo: (config: {
        account: string;
        bucketName: string;
    }) => Promise<{
        fileCount: number;
        byteCount: number;
        sources: {
            debugName: string;
            fileCount: number;
            byteCount: number;
        }[];
    } | undefined>;
    getSyncStatus: (config: {
        account: string;
        bucketName: string;
    }) => Promise<ArchivesSyncStatus>;
    startLargeFile: (config: {
        account: string;
        bucketName: string;
        path: string;
        sourceConfig: SourceConfig;
        lastModified?: number;
    }) => Promise<string>;
    uploadPart: (config: {
        uploadId: string;
        data: Buffer;
    }) => Promise<void>;
    finishLargeFile: (config: {
        uploadId: string;
    }) => Promise<void>;
    cancelLargeFile: (config: {
        uploadId: string;
    }) => Promise<void>;
    httpEntry: (config?: {
        requireCalls?: string[];
        cacheTime?: number;
    }) => Promise<Buffer>;
}>;
