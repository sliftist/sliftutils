/// <reference types="node" />
/// <reference types="node" />
import { IArchives, ArchiveFileInfo } from "../IArchives";
export type ArchivesRemoteConfig = {
    address: string;
    port: number;
    account: string;
    bucketName: string;
    public?: boolean;
    fast?: boolean;
    writeDelay?: number;
};
export declare function buildPublicFileURL(config: {
    address: string;
    port: number;
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
export declare class ArchivesRemote implements IArchives {
    private config;
    constructor(config: ArchivesRemoteConfig);
    private nodeId;
    private controller;
    private setupDone;
    private lastDeniedLog;
    getDebugName(): string;
    private authenticate;
    private callAuthed;
    waitingForAccess(): Promise<string | undefined>;
    private onAccessDenied;
    private ensureSetup;
    private call;
    get(fileName: string, config?: {
        range?: {
            start: number;
            end: number;
        };
    }): Promise<Buffer | undefined>;
    set(fileName: string, data: Buffer): Promise<void>;
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
    setLargeFile(config: {
        path: string;
        getNextData(): Promise<Buffer | undefined>;
    }): Promise<void>;
    getURL(path: string): Promise<string>;
}
