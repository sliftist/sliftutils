/// <reference types="node" />
/// <reference types="node" />
import { RemoteConfig } from "../IArchives";
/** A store's folder, from the only three things that identify it. The name is the config entry's name and nothing else: the same name is the same storage, whatever its window or route say, and a different name is different storage even for the same URL. Nothing about a folder changes when the routing does. */
export declare function getBucketFolder(name: string, account: string, bucketName: string): string;
export type StoreFolder = {
    account: string;
    name: string;
    bucketName: string;
    folder: string;
};
/** Every store this server holds for an account, found by walking the disk. */
export declare function listAccountStoreFolders(account: string): Promise<StoreFolder[]>;
/** Every store this server holds for ONE bucket - one per name it has ever been given. */
export declare function listBucketStoreFolders(account: string, bucketName: string): Promise<StoreFolder[]>;
export declare function readRoutingFile(folder: string): Promise<{
    data: Buffer;
    writeTime: number;
} | undefined>;
/** The bucket's routing config as this server holds it: the newest copy among its stores. Each store keeps its own, and they converge - so when they disagree, the one written most recently is the one that has heard the most. */
export declare function readNewestRoutingFile(account: string, bucketName: string): Promise<{
    data: Buffer;
    writeTime: number;
    size: number;
    name: string;
} | undefined>;
export declare function readRoutingFromDisk(account: string, bucketName: string): Promise<RemoteConfig | undefined>;
/** What an anonymous URL read of the routing file gets: the same newest copy. */
export declare function getRoutingFileResult(account: string, bucketName: string): Promise<{
    data: Buffer;
    writeTime: number;
    size: number;
} | undefined>;
export type BucketDiskInfo = {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
};
export declare function getDiskInfo(folder: string): Promise<BucketDiskInfo>;
