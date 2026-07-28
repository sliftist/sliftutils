import path from "path";
import fs from "fs";
import { RemoteConfig } from "../IArchives";
import { ROUTING_FILE, parseRoutingData } from "./remoteConfig";
import { getStorageServerConfig } from "./serverConfig";

// The on-disk layout, and what can be learned from it without opening a store. The layout IS the state: <account>/<name>/<bucket> is a store, and the set of folders is the set of stores this server has - there is no separate record of them to fall out of step.

// Everything this server stores for buckets. "buckets3" because the layout under it changed shape - the previous generations named folders after the route, which meant re-routing renamed the storage.
const BUCKETS_FOLDER = "buckets4";

/** A store's folder, from the only three things that identify it. The name is the config entry's name and nothing else: the same name is the same storage, whatever its window or route say, and a different name is different storage even for the same URL. Nothing about a folder changes when the routing does. */
export function getBucketFolder(name: string, account: string, bucketName: string): string {
    return path.join(getStorageServerConfig().folder, BUCKETS_FOLDER, account, name, bucketName);
}

async function readDirectory(folder: string): Promise<string[]> {
    try {
        return await fs.promises.readdir(folder);
    } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return [];
        throw e;
    }
}

export type StoreFolder = { account: string; name: string; bucketName: string; folder: string };

/** Every store this server holds for an account, found by walking the disk. */
export async function listAccountStoreFolders(account: string): Promise<StoreFolder[]> {
    let accountFolder = path.join(getStorageServerConfig().folder, BUCKETS_FOLDER, account);
    let found: StoreFolder[] = [];
    for (let name of await readDirectory(accountFolder)) {
        for (let bucketName of await readDirectory(path.join(accountFolder, name))) {
            found.push({ account, name, bucketName, folder: getBucketFolder(name, account, bucketName) });
        }
    }
    return found;
}

/** Every store this server holds for ONE bucket - one per name it has ever been given. */
export async function listBucketStoreFolders(account: string, bucketName: string): Promise<StoreFolder[]> {
    return (await listAccountStoreFolders(account)).filter(x => x.bucketName === bucketName);
}

/** The routing file is ours, on our own disk, at a path we know - so it is read directly. Going through an ArchivesDisk would construct a whole store (handle cache sweep loop, uploads-folder cleanup) just to read one file. */
function getRoutingFilePath(folder: string): string {
    return path.join(folder, "files", ROUTING_FILE);
}
export async function readRoutingFile(folder: string): Promise<{ data: Buffer; writeTime: number } | undefined> {
    let filePath = getRoutingFilePath(folder);
    try {
        let data = await fs.promises.readFile(filePath);
        let stats = await fs.promises.stat(filePath);
        // Rounded like every time ArchivesDisk reports (see its get2) - sub-millisecond mtime digits can't round-trip through utimes, so they are noise, not ordering
        return { data, writeTime: Math.round(stats.mtimeMs) };
    } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return undefined;
        throw e;
    }
}

/** The bucket's routing config as this server holds it: the newest copy among its stores. Each store keeps its own, and they converge - so when they disagree, the one written most recently is the one that has heard the most. */
export async function readNewestRoutingFile(account: string, bucketName: string): Promise<{ data: Buffer; writeTime: number; size: number; name: string } | undefined> {
    let newest: { data: Buffer; writeTime: number; size: number; name: string } | undefined;
    for (let store of await listBucketStoreFolders(account, bucketName)) {
        let file = await readRoutingFile(store.folder);
        if (!file) continue;
        if (newest && file.writeTime <= newest.writeTime) continue;
        newest = { data: file.data, writeTime: file.writeTime, size: file.data.length, name: store.name };
    }
    return newest;
}

export async function readRoutingFromDisk(account: string, bucketName: string): Promise<RemoteConfig | undefined> {
    let newest = await readNewestRoutingFile(account, bucketName);
    if (!newest) return undefined;
    return parseRoutingData(newest.data);
}

/** What an anonymous URL read of the routing file gets: the same newest copy. */
export async function getRoutingFileResult(account: string, bucketName: string): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
    return await readNewestRoutingFile(account, bucketName);
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
