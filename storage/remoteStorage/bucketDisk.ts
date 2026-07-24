import path from "path";
import fs from "fs";
import { RemoteConfig } from "../IArchives";
import { ROUTING_FILE, parseRoutingData } from "./remoteConfig";
import { getStorageServerConfig } from "./serverConfig";

// The on-disk layout of buckets, and the direct-disk reads of the files that exist outside every store: the per-route folder naming and the routing file.

/** Each ROUTE gets its own folder: the bucket name plus the route range. One store serves exactly one route, so different shards of the same bucket - even across processes on different ports of the same machine - never share a folder and can never mix their data. No route (or the full route) keeps the plain folder, which is also where the routing file always lives. */
function getRouteFolderSuffix(route: [number, number] | undefined): string {
    if (!route || route[0] === 0 && route[1] === 1) return "";
    return `-route-${route[0]}-${route[1]}`;
}
export function getBucketFolder(account: string, bucketName: string, route?: [number, number]): string {
    return path.join(getStorageServerConfig().folder, "buckets2", account, bucketName + getRouteFolderSuffix(route));
}

/** The routing file is ours, on our own disk, at a path we know - so it is read directly. Going through an ArchivesDisk would construct a whole store (handle cache sweep loop, uploads-folder cleanup) just to read one file. */
function getRoutingFilePath(folder: string): string {
    return path.join(folder, "files", ROUTING_FILE);
}
export async function readRoutingFile(folder: string): Promise<Buffer | undefined> {
    try {
        return await fs.promises.readFile(getRoutingFilePath(folder));
    } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return undefined;
        throw e;
    }
}

export async function readRoutingFromDisk(account: string, bucketName: string): Promise<RemoteConfig | undefined> {
    let data = await readRoutingFile(getBucketFolder(account, bucketName));
    if (!data) return undefined;
    return parseRoutingData(data);
}

/** The routing file lives ONLY in the plain (routeless) bucket folder - it is what DEFINES the per-route stores, so it cannot live inside any of them. Served directly for reads (the stores never hold it). */
export async function getRoutingFileResult(account: string, bucketName: string): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
    let filePath = getRoutingFilePath(getBucketFolder(account, bucketName));
    try {
        let data = await fs.promises.readFile(filePath);
        let stats = await fs.promises.stat(filePath);
        return { data, writeTime: stats.mtimeMs, size: data.length };
    } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return undefined;
        throw e;
    }
}

export type BucketDiskInfo = {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
};

export async function getDiskInfo(folder: string): Promise<BucketDiskInfo> {
    let stats = await fs.promises.statfs(folder);
    let blockSize = Number(stats.bsize);
    let totalBytes = Number(stats.blocks) * blockSize;
    return {
        totalBytes,
        // Matches the server's own low-space check: what an unprivileged process can actually use
        freeBytes: Number(stats.bavail) * blockSize,
        usedBytes: totalBytes - Number(stats.bfree) * blockSize,
    };
}
