process.env.NODE_ENV = "production";
import path from "path";
import { SocketFunction } from "socket-function/SocketFunction";
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

// The remote storage server. Run modes:
//   Host the server:
//     typenode storage/remoteStorage/storageServer.ts --domain storage.example.com --port 4444
//       --folder /storage/data --cloudflareApiTokenPath ~/example.com.key
//   Admin commands (run on the storage machine itself, against the running server):
//     --listAccess <ip>            lists pending access requests from that IP (with requestIds)
//     --grantAccess <requestId>    trusts the machine from that request for the requested account

process.on("unhandledRejection", (error) => {
    console.error("Unhandled promise rejection:", error);
});
process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});

function getArg(name: string): string | undefined {
    let index = process.argv.indexOf(`--${name}`);
    if (index < 0) return undefined;
    let value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for --${name}`);
    }
    return value;
}

async function runAdminCommand(config: { domain: string; port: number; listAccess?: string; grantAccess?: string }) {
    let nodeId = SocketFunction.connect({ address: config.domain, port: config.port });
    let controller = RemoteStorageController.nodes[nodeId];
    await authenticateStorage({ address: config.domain, port: config.port, nodeId });
    if (config.listAccess) {
        let requests = await controller.adminListRequests(config.listAccess);
        if (!requests.length) {
            console.log(`No access requests from ${config.listAccess}`);
            return;
        }
        console.log(`Access requests from ${config.listAccess}:`);
        for (let request of requests) {
            console.log(`  --grantAccess ${request.requestId}  (account ${request.account}, machine ${request.machineId}, requested ${new Date(request.time).toISOString()})`);
        }
        console.log(`Grant one with: typenode storage/remoteStorage/storageServer.ts --domain ${config.domain} --port ${config.port} --grantAccess <requestId>`);
        return;
    }
    if (config.grantAccess) {
        let record = await controller.adminGrantAccess(config.grantAccess);
        console.log(`Granted machine ${record.machineId} access to account ${JSON.stringify(record.account)}`);
    }
}

async function main() {
    let domain = getArg("domain");
    if (!domain) throw new Error(`--domain is required (ex: --domain storage.example.com)`);
    let port = +(getArg("port") || 443);

    let listAccess = getArg("listAccess");
    let grantAccess = getArg("grantAccess");
    if (listAccess || grantAccess) {
        await runAdminCommand({ domain, port, listAccess, grantAccess });
        process.exit(0);
    }

    let folder = getArg("folder");
    if (!folder) throw new Error(`--folder is required (where the storage server keeps its data)`);
    let cloudflareApiTokenPath = getArg("cloudflareApiTokenPath");
    if (!cloudflareApiTokenPath) throw new Error(`--cloudflareApiTokenPath is required (path to a Cloudflare API token file, for HTTPS certs)`);

    let root = await getFileStorageNested2(path.resolve(folder));
    let system = await root.folder.getStorage("system");
    let trust = new JSONStorage<TrustRecord>(new TransactionStorage(await system.folder.getStorage("trust"), "storageTrust"));
    let requests = new JSONStorage<AccessRequest[]>(new TransactionStorage(await system.folder.getStorage("requests"), "storageRequests"));
    let buckets = new JSONStorage<BucketConfig>(new TransactionStorage(await system.folder.getStorage("buckets"), "storageBuckets"));

    setStorageServerState({
        domain,
        port,
        rootDomain: domain.split(".").slice(-2).join("."),
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
        cloudflareApiTokenPath,
        setDNSRecord: true,
    });
    console.log(`Storage server running at https://${domain}:${port}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
