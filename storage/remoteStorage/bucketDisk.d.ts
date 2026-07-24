/// <reference types="node" />
/// <reference types="node" />
import { RemoteConfig } from "../IArchives";
export declare function getBucketFolder(account: string, bucketName: string, route?: [number, number]): string;
export declare function readRoutingFile(folder: string): Promise<Buffer | undefined>;
export declare function readRoutingFromDisk(account: string, bucketName: string): Promise<RemoteConfig | undefined>;
/** The routing file lives ONLY in the plain (routeless) bucket folder - it is what DEFINES the per-route stores, so it cannot live inside any of them. Served directly for reads (the stores never hold it). */
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
