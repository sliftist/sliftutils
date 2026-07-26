import { hostStorageServer } from "./storageServer";
import { getArg, getFlag } from "./cliArgs";

// Hosts a storage server from the command line (via the storageserver bin, see package.json).

process.on("unhandledRejection", (error) => {
    console.error("Unhandled promise rejection:", error);
});
process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});

async function main() {
    let url = getArg("url");
    if (!url) throw new Error(`--url is required (ex: --url https://storage.example.com:4444)`);
    let folder = getArg("folder");
    if (!folder) throw new Error(`--folder is required (the folder all data is stored in)`);
    let lowSpaceThresholdBytes: number | undefined;
    let lowSpaceThreshold = getArg("lowSpaceThreshold");
    if (lowSpaceThreshold) {
        lowSpaceThresholdBytes = +lowSpaceThreshold;
        if (isNaN(lowSpaceThresholdBytes)) {
            throw new Error(`--lowSpaceThreshold must be a number of bytes, was ${JSON.stringify(lowSpaceThreshold)}`);
        }
    }

    await hostStorageServer({
        url,
        folder,
        lowSpaceThresholdBytes,
        // Do not forward ports, and base the ip-domain on our internal LAN ip instead of our external ip (for LAN-only servers behind a NAT we can't/won't open)
        internal: getFlag("internal"),
        // Serve a self-signed TLS cert signed by this machine's CA instead of getting a real (ACME) one - for servers without a Cloudflare-managed domain. Clients trust it by trusting the CA, or by visiting the server once and accepting the certificate.
        selfSigned: getFlag("selfSigned"),
    });
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
