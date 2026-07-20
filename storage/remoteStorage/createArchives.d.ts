/// <reference types="node" />
/// <reference types="node" />
import { IArchives, RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig, ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus } from "../IArchives";
import { ServerBucketInfo } from "./storageServerState";
/** The address, port, account, and bucket name a bucket routing URL addresses. Throws when the URL isn't a hosted bucket routing URL (https://host:port/file/<account>/<bucketName>/storage/storagerouting.json). */
export { parseHostedUrl, parseBackblazeUrl, getBucketBaseUrl } from "./remoteConfig";
export declare function createApiArchives(source: HostedConfig | BackblazeConfig): IArchives;
export declare class ArchivesChain implements IArchives {
    private configured;
    private activeConfig;
    private statePromise;
    private initRetryDelay;
    private initRetryTimer;
    private pollTimer;
    private disposed;
    private unsubscribeRoutingPush;
    constructor(config: RemoteConfig | RemoteConfigBase);
    getDebugName(): string;
    private getState;
    private init;
    private createChainSource;
    private buildSources;
    private startConfigPoll;
    private configRefreshInFlight;
    private refreshActiveConfig;
    private fetchLatestConfig;
    private checkForNewConfig;
    private adoptNewConfig;
    private lastAvailabilityRecheck;
    private availabilityRecheckInFlight;
    private recheckAvailability;
    private recheckAvailabilityNow;
    private run;
    private runWrite;
    private lastConfigRefresh;
    private prepareWrongTargetRetry;
    private request;
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
        size: number;
    } | undefined>;
    getInfo(fileName: string): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    private selectCoveringSources;
    private runOnCovering;
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
    hasWriteAccess(): Promise<boolean>;
    set(fileName: string, data: Buffer, config?: {
        lastModified?: number;
    }): Promise<string>;
    private setRoutingConfig;
    del(fileName: string): Promise<void>;
    private setVariableShard;
    setLargeFile(config: {
        path: string;
        getNextData(): Promise<Buffer | undefined>;
    }): Promise<void>;
    getURL(path: string): Promise<string>;
    dispose(): void;
}
export declare function createArchives(config: RemoteConfig | RemoteConfigBase): ArchivesChain;
export declare function listServerBuckets(config: {
    url: string;
    account: string;
}): Promise<ServerBucketInfo[]>;
/** Zeroes the write statistics listServerBuckets reports, for every bucket in the account. */
export declare function clearServerWriteStats(config: {
    url: string;
    account: string;
}): Promise<{
    clearedBuckets: number;
}>;
export declare function getBucketInfo(config: {
    url: string;
}): Promise<ArchivesConfig>;
