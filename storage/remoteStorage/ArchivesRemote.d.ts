/// <reference types="node" />
/// <reference types="node" />
import { IArchives, ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, ChangesAfterConfig, DelConfig, FindConfig, GetConfig, GetInfoConfig, SourceConfig, SetConfig } from "../IArchives";
export type ArchivesRemoteConfig = {
    url: string;
    waitForAccess?: boolean;
    /** The exact routing-config entry this connection represents, sent with every call so the server picks the matching per-route store (one server hosts one store per route). Instances built from a bare URL fabricate one - it will never match, which only works for calls that don't select a store (internal reads, ROUTING_FILE, getConfig). */
    sourceConfig: SourceConfig;
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
    ping(): Promise<{}>;
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
    get(fileName: string, config?: GetConfig): Promise<Buffer | undefined>;
    get2(fileName: string, config?: GetConfig): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
    } | undefined>;
    set(fileName: string, data: Buffer, config?: SetConfig): Promise<string>;
    del(fileName: string, config?: DelConfig): Promise<void>;
    getInfo(fileName: string, config?: GetInfoConfig): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo(prefix: string, config?: FindConfig): Promise<ArchiveFileInfo[]>;
    find(prefix: string, config?: FindConfig): Promise<string[]>;
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    getConfig(): Promise<ArchivesConfig>;
    getSyncStatus(): Promise<ArchivesSyncStatus>;
    setLargeFile(config: {
        path: string;
        lastModified?: number;
        getNextData(): Promise<Buffer | undefined>;
    }): Promise<void>;
    getURL(path: string): Promise<string>;
}
