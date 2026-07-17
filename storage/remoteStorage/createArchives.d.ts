/// <reference types="node" />
/// <reference types="node" />
import { IArchives, RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig, ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus } from "../IArchives";
export declare function createApiArchives(source: HostedConfig | BackblazeConfig): IArchives;
export declare class ArchivesChain implements IArchives {
    private normalized;
    private adopted;
    private sourcesPromise;
    constructor(config: RemoteConfig | RemoteConfigBase);
    getDebugName(): string;
    private getSourceConfigs;
    private getSources;
    private init;
    private ensureRouting;
    private readFromSource;
    private read;
    private getAccessHelp;
    private write;
    waitingForAccess(): Promise<{
        link: string;
        machineId: string;
        ip: string;
    } | undefined>;
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
    getInfo(fileName: string): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    find(prefix: string, config?: {
        shallow?: boolean;
        type: "files" | "folders";
    }): Promise<string[]>;
    findInfo(prefix: string, config?: {
        shallow?: boolean;
        type: "files" | "folders";
    }): Promise<ArchiveFileInfo[]>;
    getChangesAfter(time: number): Promise<ArchiveFileInfo[]>;
    getSyncStatus(): Promise<ArchivesSyncStatus>;
    getConfig(): Promise<ArchivesConfig>;
    set(fileName: string, data: Buffer, config?: {
        lastModified?: number;
    }): Promise<void>;
    del(fileName: string): Promise<void>;
    setLargeFile(config: {
        path: string;
        getNextData(): Promise<Buffer | undefined>;
    }): Promise<void>;
    getURL(path: string): Promise<string>;
}
export declare function createArchives(config: RemoteConfig | RemoteConfigBase): ArchivesChain;
