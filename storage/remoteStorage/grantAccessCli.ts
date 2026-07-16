import { SocketFunction } from "socket-function/SocketFunction";
import { RemoteStorageController } from "./storageController";
import { authenticateStorage, parseStorageUrl } from "./ArchivesRemote";

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
    let url = getArg("url");
    if (!url) throw new Error(`--url is required (ex: --url https://storage.example.com:4444/storagerouting.json)`);
    let requestId = getArg("requestId");
    if (!requestId) throw new Error(`--requestId is required (the request id shown on the access page)`);

    let { address, port } = parseStorageUrl(url);
    let nodeId = SocketFunction.connect({ address, port });
    await authenticateStorage({ address, port, nodeId });
    let record = await RemoteStorageController.nodes[nodeId].adminGrantAccess(requestId);
    console.log(`Granted machine ${record.machineId} access to account ${JSON.stringify(record.account)}`);
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
