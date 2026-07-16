import os from "os";
import path from "path";
import { SocketFunction } from "socket-function/SocketFunction";
import { getExternalIP } from "socket-function/src/networking";
import { RequireController } from "socket-function/require/RequireController";
import { hostServer } from "../../misc/https/hostServer";
import { getFileStorageNested2 } from "../FileFolderAPI";
import { TransactionStorage } from "../TransactionStorage";
import { JSONStorage } from "../JSONStorage";
import { BlobStore } from "./blobStore";
import {
    RemoteStorageController, setStorageServerState,
    AccessRequest, TrustRecord, BucketConfig,
} from "./storageController";
import { authenticateStorage } from "./ArchivesRemote";
// Import browser code, so it is allowed to be required by the client
import "./accessPage";

// The remote storage server. Callers import hostStorageServer() and run it inside their own process
// (no separate entry point / bin script needed). The file is ALSO runnable directly as a testing /
// admin entry:
//   Host (test):
//     typenode storage/remoteStorage/storageServer.ts --domain storage.example.com --port 4444
//       --folder /storage/data --cloudflareApiTokenPath ~/example.com.key
//   Grant an access request (must be run on the storage machine itself):
//     typenode storage/remoteStorage/storageServer.ts --domain storage.example.com --port 4444
//       --grantAccess <requestId>
// Listing access requests is not exposed on the CLI — that flow happens in the browser on the
// access page (a trusted user types in an IP to look up and approve pending requests).

// The absolute command that runs this script (with the given args) on this machine, usable from any
// working directory (ex: over ssh). Same regardless of who imported us, since __filename points at
// this file.
function getServerCommand(args: string): string {
    return `${process.execPath} ${require.resolve("typenode/bootstrap.js")} ${__filename} ${args}`;
}

export type HostStorageServerConfig = {
    domain: string;
    port: number;
    folder: string;
    cloudflareApiToken?: string;
    cloudflareApiTokenPath?: string;
};

// Starts hosting the remote storage server in the caller's process. Exposes RemoteStorageController
// + serves the access page. Blocks until the server is listening.
export async function hostStorageServer(config: HostStorageServerConfig): Promise<void> {
    let { domain, port, folder } = config;
    let root = await getFileStorageNested2(path.resolve(folder));
    let system = await root.folder.getStorage("system");
    let trust = new JSONStorage<TrustRecord>(new TransactionStorage(await system.folder.getStorage("trust"), "storageTrust"));
    let requests = new JSONStorage<AccessRequest[]>(new TransactionStorage(await system.folder.getStorage("requests"), "storageRequests"));
    let buckets = new JSONStorage<BucketConfig>(new TransactionStorage(await system.folder.getStorage("buckets"), "storageBuckets"));

    setStorageServerState({
        domain,
        port,
        rootDomain: domain.split(".").slice(-2).join("."),
        sshTarget: `${os.userInfo().username}@${await getExternalIP()}`,
        serverCommand: getServerCommand(`--domain ${domain} --port ${port}`),
        blobStore: new BlobStore(path.resolve(folder)),
        trust,
        requests,
        buckets,
    });

    RequireController.allowAllNodeModules();
    SocketFunction.expose(RequireController);
    SocketFunction.expose(RemoteStorageController);
    // No static roots, so the access page HTML is served at every path (the path is the account
    // name, see accessPage.tsx)
    // A full URL, so the page resolves modules from the origin root even when served at
    // /accountName (a relative require would resolve inside the account path)
    SocketFunction.setDefaultHTTPCall(RequireController, "requireHTML", {
        requireCalls: [`https://${domain}:${port}/./storage/remoteStorage/accessPage.tsx`],
    });

    await hostServer({
        domain,
        port,
        cloudflareApiToken: config.cloudflareApiToken,
        cloudflareApiTokenPath: config.cloudflareApiTokenPath,
        setDNSRecord: true,
    });
}

// Admin: grants an access request by requestId. Must be run on the storage machine itself (the CLI
// entry below authenticates with this machine's certs.ts identity, which is what the server trusts
// as admin).
export async function grantAccessRequest(config: { domain: string; port: number; requestId: string }): Promise<TrustRecord> {
    let nodeId = SocketFunction.connect({ address: config.domain, port: config.port });
    await authenticateStorage({ address: config.domain, port: config.port, nodeId });
    return await RemoteStorageController.nodes[nodeId].adminGrantAccess(config.requestId);
}

function getArg(name: string): string | undefined {
    let index = process.argv.indexOf(`--${name}`);
    if (index < 0) return undefined;
    let value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for --${name}`);
    }
    return value;
}

async function cliMain() {
    let domain = getArg("domain");
    if (!domain) throw new Error(`--domain is required (ex: --domain storage.example.com)`);
    let port = +(getArg("port") || 443);

    let grantAccessArg = getArg("grantAccess");
    if (grantAccessArg) {
        let record = await grantAccessRequest({ domain, port, requestId: grantAccessArg });
        console.log(`Granted machine ${record.machineId} access to account ${JSON.stringify(record.account)}`);
        process.exit(0);
    }

    let folder = getArg("folder");
    if (!folder) throw new Error(`--folder is required (where the storage server keeps its data)`);
    let cloudflareApiTokenPath = getArg("cloudflareApiTokenPath");
    if (!cloudflareApiTokenPath) throw new Error(`--cloudflareApiTokenPath is required (path to a Cloudflare API token file, for HTTPS certs)`);

    await hostStorageServer({ domain, port, folder, cloudflareApiTokenPath });
    console.log(`Storage server running at https://${domain}:${port}`);
}

// Only run the CLI when this file is invoked directly (typenode storageServer.ts ...), not when a
// consumer imports us as a library.
if (require.main === module) {
    process.env.NODE_ENV = "production";
    process.on("unhandledRejection", (error) => {
        console.error("Unhandled promise rejection:", error);
    });
    process.on("uncaughtException", (error) => {
        console.error("Uncaught exception:", error);
    });
    cliMain().catch(e => {
        console.error(e);
        process.exit(1);
    });
}
