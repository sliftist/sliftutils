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
    private checkForNewConfig;
    private run;
    private runWrite;
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
    private runOnApi;
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
    private assertNotBareVariableShard;
    set(fileName: string, data: Buffer, config?: {
        lastModified?: number;
    }): Promise<void>;
    del(fileName: string): Promise<void>;
    /** Writes a key containing the VARIABLE_SHARD sentinel: picks the lowest-latency up write
     *  shard, materializes the key with a random value inside that shard's route, writes it, and
     *  returns the FULL key actually written (the caller needs it to ever read the value back).
     *  Unlike normal writes this CAN move to another shard when the preferred one is down (error +
     *  socket down, same rule as reads) - each shard receives a different key, so write
     *  consistency is preserved. */
    setVariableShard(key: string, data: Buffer, config?: {
        lastModified?: number;
    }): Promise<string>;
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
