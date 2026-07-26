/// <reference types="node" />
/// <reference types="node" />
import { BlobStore } from "./blobStore";
import { RemoteConfig, SourceConfig, IArchives, ArchivesConfig, ArchivesSyncStatus } from "../IArchives";
import { BucketDiskInfo } from "./bucketDisk";
import { BucketWriteStats } from "./accessStats";
export declare function getStore(account: string, bucketName: string, name: string, callerNodeId?: string): BlobStore;
/** The store serving a request: the one the client's selected entry NAMES. Account, name, and bucket ARE the folder, so this is a direct lookup, never a search of what exists - and a name this server has never seen is CREATED, never rejected, because asking for a name is the instruction to have that store (one name, one folder, one index; it configures itself once the routing config lands in it). Nothing else about the request is compared - not the window, not the route, not the flags - which is the whole point of naming it: a client a config version behind on some flag still reaches the right store. */
export declare function findBucketStore(account: string, bucketName: string, sourceConfig: SourceConfig | undefined): BlobStore;
/** The stores of a bucket as the DISK records them (a bucket is nothing more than the store folders sharing its name), opened - so the ones that weren't running yet start synchronizing. Empty when the bucket does not exist here. */
export declare function getBucketStores(account: string, bucketName: string): Promise<{
    name: string;
    store: BlobStore;
}[]>;
/** Internal (store-to-store) reads skip store selection entirely: the caller is another store whose index says this MACHINE holds the bytes - the persisted holder identity is just a URL, which cannot name a store. Whichever store's folder has the newest copy answers. */
export declare function readBucketInternal(account: string, bucketName: string, config: {
    path: string;
    range?: {
        start: number;
        end: number;
    };
    includeTombstones?: boolean;
}): Promise<{
    data: Buffer;
    writeTime: number;
    size: number;
} | undefined>;
export declare function getBucketArchivesConfig(account: string, bucketName: string): Promise<ArchivesConfig>;
export declare function bucketSyncStatus(account: string, bucketName: string): Promise<ArchivesSyncStatus>;
export declare function debugBucketIndexTotals(account: string, bucketName: string): Promise<{
    fileCount: number;
    byteCount: number;
    sources: {
        debugName: string;
        fileCount: number;
        byteCount: number;
    }[];
}>;
/** A cached IArchives for a persisted source identity: a routing URL (hosted/backblaze) or a disk folder path - the form BlobStore's sources list stores. Configuration (valid windows, routes) decides WHEN a source should be used; for reading bytes the index says a source holds, the URL alone is enough - even for sources no longer in any config. */
export declare function resolveSourceArchives(url: string): IArchives;
/**
 * Writing the routing config is a write like any other: it goes into a store, and the store applies
 * it to itself and lets its peers pull it. The only thing that happens here is picking WHICH store,
 * because the writer names a source and a source names a store.
 *
 * In-flight switchover windows are re-injected first (see intermediateManagement): an operator's
 * config knows nothing about a switchover that is happening right now, and writing it as-is would
 * cancel it mid-flight.
 */
export declare function writeRoutingConfig(account: string, bucketName: string, name: string, data: Buffer, config?: {
    lastModified?: number;
}): Promise<void>;
/** Which buckets this process currently has active (some store of theirs was opened) - what a deploy successor asks its predecessor for, so it activates exactly the buckets that are actually in use. */
export declare function getActiveBucketKeys(): {
    account: string;
    bucketName: string;
}[];
export type ServerBucketInfo = {
    bucketName: string;
    active: boolean;
    /** Where the bucket's data lives on this server */
    folder: string;
    /** The drive that folder is on. Buckets sharing a drive report the same numbers. */
    disk?: BucketDiskInfo;
    diskError?: string;
    writeStats?: BucketWriteStats;
    config?: ArchivesConfig;
    error?: string;
};
export type ActiveBucketInfo = {
    folder: string;
    /** The bucket's routing config, the newest copy among its stores. Absent when none of them has one yet. */
    routing?: RemoteConfig;
    config: ArchivesConfig;
};
/** The state of ONE active bucket. Returns an error string when the bucket is not active here, which is the normal state for a bucket nothing has accessed since startup. */
export declare function debugGetActiveBucket(account: string, bucketName: string): Promise<ActiveBucketInfo | string>;
/** Loads every store of a bucket that exists on this server's disk into memory, which starts their synchronization and window timers, and returns the bucket's state. Nothing is written and no other server is contacted - unlike building an ArchivesChain for it, which would probe every source and could write the routing config. Already-active buckets just return their state. */
export declare function activateBucket(account: string, bucketName: string): Promise<ActiveBucketInfo | string>;
export declare function debugListAccountBuckets(account: string): Promise<ServerBucketInfo[]>;
