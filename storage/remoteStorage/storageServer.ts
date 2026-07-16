import os from "os";
import path from "path";
import fsp from "fs/promises";
import { SocketFunction } from "socket-function/SocketFunction";
import { getExternalIP } from "socket-function/src/networking";
import { RequireController } from "socket-function/require/RequireController";
import { hostServer } from "../../misc/https/hostServer";
import { getFileStorageNested2 } from "../FileFolderAPI";
import { TransactionStorage } from "../TransactionStorage";
import { JSONStorage } from "../JSONStorage";
import { BlobStore } from "./blobStore";
import {
    RemoteStorageController, setStorageServerState, setWritesRejectedReason,
    AccessRequest, TrustRecord, BucketConfig,
} from "./storageController";
import { parseStorageUrl } from "./ArchivesRemote";
// Import browser code, so it is allowed to be required by the client
import "./accessPage";

const DEFAULT_LOW_SPACE_THRESHOLD_BYTES = 25 * 1024 ** 3;
const DISK_SPACE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
// Below this fraction of the warn threshold, we start rejecting writes so the server itself doesn't
// tip the machine into instability. Reads/deletes still work so users can free space.
const HARD_REJECT_FRACTION = 0.1;

// The remote storage server, as a library function: consumers call hostStorageServer() from their
// own process to start hosting (or use the storageserver bin, see storageServerCli.ts). The
// grantAccess.js bootstrap (next to this file) is what the access page's shown SSH command points at.

export type HostStorageServerConfig = {
    // Full URL of this storage server, e.g. "https://storage.example.com:4444/storagerouting.json".
    // The domain and port are extracted from it; the path is reserved for the routing config
    // (handled elsewhere). The exact same URL is what clients pass to createArchivesRemoteFactory.
    url: string;
    folder: string;
    // Set hostServer.ts:HostServerConfig:cloudflareApiToken
    cloudflareApiToken: { key: string } | { path: string };
    // When free space on the folder's drive drops below this many bytes, the server console.errors
    // every 15 minutes. Below 10% of it, the server also rejects write operations (creating files,
    // large uploads, new buckets) — reads, findInfo, and deletes still work so the user can free
    // space. Default 25 GiB.
    lowSpaceThresholdBytes?: number;
};

function formatBytes(bytes: number): string {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

async function checkDiskSpace(config: { folder: string; threshold: number }): Promise<void> {
    let { folder, threshold } = config;
    let stats = await fsp.statfs(folder);
    let free = Number(stats.bavail) * Number(stats.bsize);
    let hardLimit = threshold * HARD_REJECT_FRACTION;
    if (free >= threshold) {
        setWritesRejectedReason(undefined);
        return;
    }
    let under = threshold - free;
    let rejecting = free < hardLimit;
    console.error(
        `Storage folder ${folder} is low on disk: ${formatBytes(free)} free`
        + ` (warn threshold ${formatBytes(threshold)}, ${formatBytes(under)} under;`
        + ` hard-reject threshold ${formatBytes(hardLimit)}${rejecting ? ", REACHED — write ops now rejected" : ""}).`
    );
    if (rejecting) {
        setWritesRejectedReason(
            `Storage server is out of disk space: only ${formatBytes(free)} free on ${folder}`
            + ` (hard-reject threshold ${formatBytes(hardLimit)}, warn threshold ${formatBytes(threshold)}).`
            + ` Write operations (create/append/new bucket) are rejected; reads, findInfo, and deletes still work — please free space.`
        );
    } else {
        setWritesRejectedReason(undefined);
    }
}

// Full path to the grantAccess CLI bootstrap that lives next to this file. The SSH command shown on
// the access page invokes it via `node <path> ...` (found through __dirname so consumers don't have
// to know where our source lives).
function getGrantAccessCliPath(): string {
    return path.join(__dirname, "grantAccess.js");
}

export async function hostStorageServer(config: HostStorageServerConfig): Promise<void> {
    let { url, folder } = config;
    let { address: domain, port } = parseStorageUrl(url);
    let lowSpaceThreshold = config.lowSpaceThresholdBytes ?? DEFAULT_LOW_SPACE_THRESHOLD_BYTES;
    let rootFolder = path.resolve(folder);
    let root = await getFileStorageNested2(rootFolder);
    let system = await root.folder.getStorage("system");
    let trust = new JSONStorage<TrustRecord>(new TransactionStorage(await system.folder.getStorage("trust"), "storageTrust"));
    let requests = new JSONStorage<AccessRequest[]>(new TransactionStorage(await system.folder.getStorage("requests"), "storageRequests"));
    let buckets = new JSONStorage<BucketConfig>(new TransactionStorage(await system.folder.getStorage("buckets"), "storageBuckets"));

    let blobStores = new Map<string, BlobStore>();
    setStorageServerState({
        domain,
        port,
        rootDomain: domain.split(".").slice(-2).join("."),
        sshTarget: `${os.userInfo().username}@${await getExternalIP()}`,
        serverCommand: `node ${getGrantAccessCliPath()} --url ${url}`,
        getBlobStore(bucket: BucketConfig) {
            let store = blobStores.get(bucket.folder);
            if (!store) {
                store = new BlobStore(path.join(rootFolder, bucket.folder));
                blobStores.set(bucket.folder, store);
            }
            return store;
        },
        trust,
        requests,
        buckets,
    });

    RequireController.allowAllNodeModules();
    SocketFunction.expose(RequireController);
    SocketFunction.expose(RemoteStorageController);
    // No static roots, so the access page HTML is served at every path (the path is the account
    // name, see accessPage.tsx).
    // A full URL, so the page resolves modules from the origin root even when served at
    // /accountName (a relative require would resolve inside the account path).
    SocketFunction.setDefaultHTTPCall(RequireController, "requireHTML", {
        requireCalls: [`https://${domain}:${port}/./storage/remoteStorage/accessPage.tsx`],
    });

    // Initial check so a server starting under-limit immediately rejects writes; then keep checking
    // every 15 minutes so recovery (freed disk space) is picked up automatically.
    await checkDiskSpace({ folder, threshold: lowSpaceThreshold });
    let interval = setInterval(() => {
        void checkDiskSpace({ folder, threshold: lowSpaceThreshold })
            .catch(e => console.error(`Disk space check failed for ${folder}:`, e));
    }, DISK_SPACE_CHECK_INTERVAL_MS);
    (interval as { unref?: () => void }).unref?.();

    await hostServer({
        domain,
        port,
        cloudflareApiToken: config.cloudflareApiToken,
        setDNSRecord: true,
    });
}
