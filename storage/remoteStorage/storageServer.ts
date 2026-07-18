import os from "os";
import path from "path";
import fsp from "fs/promises";
import { SocketFunction } from "socket-function/SocketFunction";
import { getExternalIP } from "socket-function/src/networking";
import { RequireController } from "socket-function/require/RequireController";
import { hostServer } from "../../misc/https/hostServer";
import { RemoteStorageController } from "./storageController";
import { setStorageServerConfig, setWritesRejectedReason } from "./storageServerState";
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
    // Full URL of this storage server, e.g. "https://1-2-3-4.example.com:4444". The subdomain must
    // be an ip domain - this machine's external IP with dashes, or 127-0-0-1 for local testing
    // (see the validation in hostStorageServer). The domain and port are extracted from it (bucket
    // routing URLs clients use look like
    // https://1-2-3-4.example.com:4444/file/<account>/<bucketName>/storage/storagerouting.json).
    url: string;
    folder: string;
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
    let rootDomain = domain.split(".").slice(-2).join(".");
    let externalIP = (await getExternalIP()).trim();
    // The subdomain must be an ip domain: the domain's A record points at exactly one machine, so a
    // dynamic name would let the same script run on two servers and silently fight over it. Encoding
    // the IP makes that mistake fail loudly - the wrong machine's domain just doesn't match.
    let allowedDomains = [`127-0-0-1.${rootDomain}`, `${externalIP.replaceAll(".", "-")}.${rootDomain}`];
    if (!allowedDomains.includes(domain)) {
        throw new Error(`The storage server domain is based on the machine's IP (the subdomain is the IP with dots replaced by dashes). Expected ${allowedDomains.join(" or ")}, was ${domain}. Your external IP is ${externalIP}.`);
    }
    await fsp.mkdir(folder, { recursive: true });
    let lowSpaceThreshold = config.lowSpaceThresholdBytes ?? DEFAULT_LOW_SPACE_THRESHOLD_BYTES;
    setStorageServerConfig({
        domain,
        port,
        rootDomain,
        sshTarget: `${os.userInfo().username}@${externalIP}`,
        serverCommand: `node ${getGrantAccessCliPath()} --url ${url}`,
        folder: path.resolve(folder),
    });

    RequireController.allowAllNodeModules();
    SocketFunction.expose(RequireController);
    SocketFunction.expose(RemoteStorageController);
    // Every HTTP path goes through httpEntry: /file/<account>/<bucketName>/... serves public
    // bucket files, everything else serves the access page (the path is the account name, see
    // accessPage.tsx).
    // A full URL, so the page resolves modules from the origin root even when served at
    // /accountName (a relative require would resolve inside the account path).
    SocketFunction.setDefaultHTTPCall(RemoteStorageController, "httpEntry", {
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
        setDNSRecord: true,
    });
}
