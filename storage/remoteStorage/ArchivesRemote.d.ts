/// <reference types="node" />
/// <reference types="node" />
import { IArchives, ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus } from "../IArchives";
export type ArchivesRemoteBucketConfig = {
    bucketName: string;
    public?: boolean;
    fast?: boolean;
    writeDelay?: number;
    rawDisk?: boolean;
    immutable?: boolean;
};
export type ArchivesRemoteConfig = ArchivesRemoteBucketConfig & {
    url: string;
    account: string;
};
export declare function parseStorageUrl(url: string): {
    address: string;
    port: number;
};
export declare function buildPublicFileURL(config: {
    url: string;
    account: string;
    bucketName: string;
    path: string;
}): string;
export declare function authenticateStorage(config: {
    address: string;
    port: number;
    nodeId: string;
}): Promise<{
    machineId: string;
    ip: string;
}>;
export declare class ArchivesRemoteFactory {
    private config;
    constructor(config: {
        url: string;
        account: string;
    });
    getBucket(bucket: ArchivesRemoteBucketConfig): ArchivesRemote;
}
export declare function createArchivesRemoteFactory(config: {
    url: string;
    account: string;
}): ArchivesRemoteFactory;
export declare class ArchivesRemote implements IArchives {
    private config;
    constructor(config: ArchivesRemoteConfig);
    private parsed;
    private nodeId;
    private controller;
    private setupDone;
    private lastDeniedLog;
    getDebugName(): string;
    private authenticate;
    private callAuthed;
    waitingForAccess(): Promise<{
        link: string;
        machineId: string;
        ip: string;
    } | undefined>;
    private onAccessDenied;
    private ensureSetup;
    private call;
    get(fileName: string, config?: {
        range?: {
            start: number;
            end: number;
        };
    }): Promise<Buffer | undefined>;
    get2(fileName: string, config?: {
        range?: {
            start: number;
            end: number;
        };
    }): Promise<{
        data: Buffer;
        writeTime: number;
    } | undefined>;
    set(fileName: string, data: Buffer, config?: {
        lastModified?: number;
    }): Promise<void>;
    del(fileName: string): Promise<void>;
    getInfo(fileName: string): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo(prefix: string, config?: {
        shallow?: boolean;
        type: "files" | "folders";
    }): Promise<ArchiveFileInfo[]>;
    find(prefix: string, config?: {
        shallow?: boolean;
        type: "files" | "folders";
    }): Promise<string[]>;
    getChangesAfter(time: number): Promise<ArchiveFileInfo[]>;
    getConfig(): Promise<ArchivesConfig>;
    getSyncStatus(): Promise<ArchivesSyncStatus>;
    setLargeFile(config: {
        path: string;
        getNextData(): Promise<Buffer | undefined>;
    }): Promise<void>;
    getURL(path: string): Promise<string>;
}
