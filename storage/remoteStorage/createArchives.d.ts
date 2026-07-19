/// <reference types="node" />
/// <reference types="node" />
import { IArchives, RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig, ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus } from "../IArchives";
import { ServerBucketInfo } from "./storageServerState";
export declare function createApiArchives(source: HostedConfig | BackblazeConfig): IArchives;
export declare class ArchivesChain implements IArchives {
    private configured;
    private activeConfig;
    private statePromise;
    private initRetryDelay;
    private initRetryTimer;
    private pollTimer;
    private disposed;
    constructor(config: RemoteConfig | RemoteConfigBase);
    getDebugName(): string;
    private getState;
    private init;
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
    /** True only when EVERY write-receiving source would accept our writes (partial write access
     *  desynchronizes sources, so it counts as no access). */
    hasWriteAccess(): Promise<boolean>;
    /** Returns the full key written. Plain keys come back unchanged; keys containing VARIABLE_SHARD
     *  are automatically materialized (a shard value is picked and embedded, see setVariableShard)
     *  and the caller needs the returned key to ever read the value back. */
    set(fileName: string, data: Buffer, config?: {
        lastModified?: number;
    }): Promise<string>;
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
/** Every bucket an account has on one storage server - active and inactive - with each bucket's
 *  configuration. One authenticated call (the normal trust system applies): no ArchivesChain, no
 *  synchronization, and inactive buckets on the server stay inactive. Any URL addressing the
 *  server works (a bucket routing URL, or just https://host:port). */
export declare function listServerBuckets(config: {
    url: string;
    account: string;
}): Promise<ServerBucketInfo[]>;
/** Live info for one bucket given its routing URL (getConfig: routing config, index totals, disk
 *  limit, in-progress synchronization). One authenticated call to that server - a light, safe
 *  alternative to instantiating an ArchivesChain, which would start synchronization machinery. */
export declare function getBucketInfo(config: {
    url: string;
    accountName?: string;
}): Promise<ArchivesConfig>;
