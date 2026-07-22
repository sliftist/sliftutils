/// <reference types="node" />
/// <reference types="node" />
import { IArchives, RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig, ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, ChangesAfterConfig, GetConfig, SetConfig } from "../IArchives";
import { ServerBucketInfo, ActiveBucketInfo } from "./storageServerState";
/** The address, port, account, and bucket name a bucket routing URL addresses. Throws when the URL isn't a hosted bucket routing URL (https://host:port/file/<account>/<bucketName>/storage/storagerouting.json). */
export { parseHostedUrl, parseBackblazeUrl, getBucketBaseUrl } from "./remoteConfig";
export declare function createApiArchives(source: HostedConfig | BackblazeConfig): IArchives;
export type ArchivesChainOptions = {
    /** Outside of node we default to read-only downloads over the public URLs (no API connection) when the config has public sources. Set this to connect to the API anyway - needed for writing, listing, and any other operation the plain URL form cannot serve. */
    directConnect?: boolean;
};
export declare class ArchivesChain implements IArchives {
    private options?;
    private configured;
    private activeConfig;
    private statePromise;
    private initRetryDelay;
    private initRetryTimer;
    private pollTimer;
    private disposed;
    private unsubscribeRoutingPush;
    constructor(config: RemoteConfig | RemoteConfigBase, options?: ArchivesChainOptions | undefined);
    getDebugName(): string;
    private getState;
    private init;
    /** Clientside, a config with public sources is served entirely over plain URL downloads - no API connection, no access grant, and no writing. directConnect opts out of that. */
    private isReadOnly;
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
    get(fileName: string, config?: GetConfig): Promise<Buffer | undefined>;
    get2(fileName: string, config?: GetConfig): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
        url: string;
    } | undefined>;
    getInfo(fileName: string): Promise<{
        writeTime: number;
        size: number;
        url: string;
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
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    getSyncStatus(): Promise<ArchivesSyncStatus>;
    getConfig(): Promise<ArchivesConfig>;
    hasWriteAccess(): Promise<boolean>;
    set(fileName: string, data: Buffer, config?: SetConfig): Promise<string>;
    private setRoutingConfig;
    del(fileName: string): Promise<void>;
    private getVariableShardTargets;
    /** The key setVariableShard would materialize for this VARIABLE_SHARD key (a value in the preferred shard's route range), without writing anything. */
    getShardKey(key: string): Promise<string>;
    private setVariableShard;
    setLargeFile(config: {
        path: string;
        lastModified?: number;
        getNextData(): Promise<Buffer | undefined>;
    }): Promise<void>;
    getURL(path: string): Promise<string>;
    /** Every URL that could serve this path, in source order: public sources matching both the path's route and the current valid window. Empty when none qualify. */
    getURLs(path: string): Promise<string[]>;
    dispose(): void;
}
export declare function createArchives(config: RemoteConfig | RemoteConfigBase, options?: ArchivesChainOptions): ArchivesChain;
export declare function listServerBuckets(config: {
    url: string;
    account: string;
}): Promise<ServerBucketInfo[]>;
/** The live, in-memory state of one bucket on a server (routing config included), or a string saying why it is unavailable. Cheap - it never touches the server's disk - but only works while that bucket is loaded there. */
export declare function getServerActiveBucket(config: {
    url: string;
    account: string;
    bucketName: string;
}): Promise<ActiveBucketInfo | string>;
/** The buckets a server currently has loaded. Admin only, so in practice this is our own machine's other process - a deploy successor asking its predecessor what is actually in use. */
export declare function listServerActiveBucketKeys(config: {
    url: string;
}): Promise<{
    account: string;
    bucketName: string;
}[]>;
/** Tells a server to load one of its buckets into memory (starting its synchronization) and returns its live state, or a string saying why it could not be loaded. Only touches that server - nothing is written and no other source is contacted. */
export declare function activateServerBucket(config: {
    url: string;
    account: string;
    bucketName: string;
}): Promise<ActiveBucketInfo | string>;
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
