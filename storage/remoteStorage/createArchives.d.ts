/// <reference types="node" />
/// <reference types="node" />
import { IArchives, RemoteConfig, RemoteConfigBase, SourceConfig, ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, ChangesAfterConfig, DelConfig, FindConfig, GetConfig, GetInfoConfig, MoveFileConfig, SetConfig, SetLargeFileConfig } from "../IArchives";
import { ServerBucketInfo, ActiveBucketInfo } from "./storageServerState";
import { LogFileInfo } from "../StreamingLogs";
/** The address, port, account, and bucket name a bucket routing URL addresses. Throws when the URL isn't a hosted bucket routing URL (https://host:port/file/<account>/<bucketName>/storage/storagerouting.json). */
export { parseHostedUrl, parseBackblazeUrl, getBucketBaseUrl } from "./remoteConfig";
/** A client for ONE source - see storeSources.ts. Re-exported here because a chain is built out of them. */
export { createApiArchives } from "./storeSources";
export type ArchivesChainOptions = {
    /** Outside of node we default to read-only downloads over the public URLs (no API connection) when the config has public sources. Set this to connect to the API anyway - needed for writing, listing, and any other operation the plain URL form cannot serve. */
    directConnect?: boolean;
};
export declare class ArchivesChain implements IArchives {
    private state;
    constructor(config: RemoteConfig | RemoteConfigBase, options?: ArchivesChainOptions);
    getDebugName(): string;
    private run;
    private runPrimary;
    /** Races call against a size-based deadline. Uploads know their size upfront; gets are given SMART_TIMEOUT_PROBE to produce anything, and only then is the file's info fetched (from the same source, itself time-limited) to size the deadline - measured from the call's start, so a source that was slow before the probe doesn't get the full allowance again. Timed-out calls keep running in the background (they cannot be cancelled) but their eventual result is ignored. */
    private applySmartTimeout;
    private lastConfigRefresh;
    private prepareWrongTargetRetry;
    private request;
    waitingForAccess(): Promise<{
        link: string;
        machineId: string;
        ip: string;
    } | undefined>;
    /** The sources that can serve a file right now, in dispatch order - the first is the write node, the one a plain read asks first. Each entry's url is what GetConfig.sourceUrl / GetInfoConfig.sourceUrl accept, so listing these and then reading with sourceUrl compares the copies the sources actually hold. */
    getFileSources(fileName: string): Promise<SourceConfig[]>;
    private runOnSource;
    get(fileName: string, config?: GetConfig): Promise<Buffer | undefined>;
    /** get2, but trying sources in latency order (fastest first) instead of config order. While this is much faster, it might miss immediate writes: the write node is no longer tried first, so a lagging replica may answer with a slightly older value. Exclusive with noFallbacks (which only considers one source - the write node - so there is no order to speed up); passing both throws. */
    getFast(fileName: string, config?: GetConfig): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
        url: string;
    } | {
        data?: undefined;
        writeTime?: undefined;
        size?: undefined;
        url: string;
    }>;
    /** Always resolves with a url - the authority that answered. A value that doesn't exist is still an answer FROM a server, so it comes back as { url } with no data (never plain undefined); errors from every source throw instead. */
    get2(fileName: string, config?: GetConfig): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
        url: string;
    } | {
        data?: undefined;
        writeTime?: undefined;
        size?: undefined;
        url: string;
    }>;
    getInfo(fileName: string, config?: GetInfoConfig): Promise<{
        writeTime: number;
        size: number;
        url: string;
    } | undefined>;
    private selectCoveringSources;
    private runOnCovering;
    find(prefix: string, config?: FindConfig): Promise<string[]>;
    findInfo(prefix: string, config?: FindConfig): Promise<ArchiveFileInfo[]>;
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    getSyncStatus(): Promise<ArchivesSyncStatus>;
    getConfig(): Promise<ArchivesConfig>;
    hasWriteAccess(): Promise<boolean>;
    set(fileName: string, data: Buffer, config?: SetConfig): Promise<string>;
    private setRoutingConfig;
    del(fileName: string, config?: DelConfig): Promise<void>;
    /** See IArchives.undelete: restores a file marked for deletion, dispatched to the write node as SetConfig.undelete (the write node propagates the restore to its peers itself). */
    undelete(fileName: string): Promise<void>;
    /** See IArchives.move. When one node is the write target for BOTH paths, that node moves the file itself - the bytes never come through us - with the same wrong-window/route re-resolution as any write. When the paths route to different shards no single node holds both, so the move degrades to a copy through us plus a delete, CONFIRMED at the destination before the source is touched. No smart timeout on the node-side move: it can be a big file's worth of node-side work, which the upload-sized deadlines would misjudge. */
    move(config: MoveFileConfig): Promise<void>;
    private getVariableShardTargets;
    /** The key setVariableShard would materialize for this VARIABLE_SHARD key (a value in the preferred shard's route range), without writing anything. */
    getShardKey(key: string): Promise<string>;
    private setVariableShard;
    /** A large file is written exactly like a small one - same write node, same wrong-window/route re-resolution, same fallbacks - so a value's SIZE never decides its write semantics (set streams through here past LARGE_SET_THRESHOLD, and a file that grew past it must not suddenly lose the availability its caller asked for). The one difference: every attempt after the first has to rewind the stream, so a config without restartStream gets a single attempt. */
    setLargeFile(config: SetLargeFileConfig): Promise<void>;
    private setLargeFileOnce;
    getURL(path: string): Promise<string>;
    /** Every URL that could serve this path: public sources matching both the path's route and the current valid window. The first is the write node's (first matching source in config order, see runPrimary - the one guaranteed current); the rest are ranked fastest-first by measured latency. Empty when none qualify. */
    getURLs(path: string): Promise<string[]>;
    /** getURLs, but after the one await (initialization) the returned function is synchronous: everything underneath - route hashing, window checks, latencies, URL building - is synchronous, and the closure always reads the newest adopted config, so it stays correct across config refreshes. */
    getGetURLs(): Promise<(path: string) => string[]>;
    /** getGetURLs, but sorted purely by latency - the write node gets no special first position. For read-only consumers that just want the fastest host. */
    getGetFastURLs(): Promise<(path: string) => string[]>;
    private makeGetURLs;
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
/** The operation-log files ONE storage server holds (every server logs only its own operations - see listAllServerLogFiles for the whole fleet). The names carry pid/thread/time-range/entry-count metadata; see LogFileInfo. */
export declare function listServerLogFiles(config: {
    url: string;
    account: string;
}): Promise<LogFileInfo[]>;
/** Every server's log files at once, one entry per url - a server that cannot answer reports its error instead of failing the rest. */
export declare function listAllServerLogFiles(config: {
    urls: string[];
    account: string;
}): Promise<{
    url: string;
    files?: LogFileInfo[];
    error?: string;
}[]>;
/** Downloads the named log files off one server and decodes them into the logged objects (the wire always carries them LZ4-compressed - live files are compressed in memory server-side). */
export declare function getServerLogs(config: {
    url: string;
    account: string;
    names: string[];
}): Promise<{
    name: string;
    entries: unknown[];
}[]>;
/** getServerLogs, but SEARCHED instead of fully decoded: the raw JSON text is substring-matched (every search string must appear in a statement - see createLogSearcher), and only the matching statements are decoded into objects. Far cheaper than decoding whole files to look for one path or caller. */
export declare function searchServerLogs(config: {
    url: string;
    account: string;
    names: string[];
    searches: string[];
}): Promise<{
    name: string;
    entries: unknown[];
}[]>;
export declare function getBucketInfo(config: {
    url: string;
}): Promise<ArchivesConfig>;
