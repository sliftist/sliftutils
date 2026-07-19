/// <reference types="node" />
/// <reference types="node" />
import { IArchives, ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus } from "../IArchives";
export type ArchivesRemoteConfig = {
    url: string;
    accountName?: string;
    waitForAccess?: boolean;
};
export declare function parseStorageUrl(url: string): {
    address: string;
    port: number;
};
export declare function authenticateStorage(config: {
    address: string;
    port: number;
    nodeId: string;
}): Promise<{
    machineId: string;
    ip: string;
}>;
export declare class ArchivesRemote implements IArchives {
    private config;
    constructor(config: ArchivesRemoteConfig);
    private parsed;
    private account;
    private bucketName;
    private nodeId;
    private controller;
    private lastDeniedLog;
    getDebugName(): string;
    isConnected(): boolean;
    ping(): Promise<void>;
    private authenticate;
    private callAuthed;
    waitingForAccess(): Promise<{
        link: string;
        machineId: string;
        ip: string;
    } | undefined>;
    hasWriteAccess(): Promise<boolean>;
    private registerAccessRequest;
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
        size: number;
    } | undefined>;
    set(fileName: string, data: Buffer, config?: {
        lastModified?: number;
    }): Promise<string>;
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
