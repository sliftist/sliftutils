import { SocketFunction } from "socket-function/SocketFunction";
import { RemoteStorageController } from "./storageController";
import { authenticateStorage } from "./ArchivesRemote";

// The grantAccess CLI. Invoked via the sibling grantAccess.js bootstrap (which loads typenode and
// then requires this file). Grants a specific access request by its requestId; must be run on the
// storage machine itself (its certs.ts identity is what the server trusts as admin).

function getArg(name: string): string | undefined {
    let index = process.argv.indexOf(`--${name}`);
    if (index < 0) return undefined;
    let value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for --${name}`);
    }
    return value;
}

async function main() {
    let domain = getArg("domain");
    if (!domain) throw new Error(`--domain is required (ex: --domain storage.example.com)`);
    let port = +(getArg("port") || 443);
    let requestId = getArg("requestId");
    if (!requestId) throw new Error(`--requestId is required (the request id shown on the access page)`);

    let nodeId = SocketFunction.connect({ address: domain, port });
    await authenticateStorage({ address: domain, port, nodeId });
    let record = await RemoteStorageController.nodes[nodeId].adminGrantAccess(requestId);
    console.log(`Granted machine ${record.machineId} access to account ${JSON.stringify(record.account)}`);
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
