process.env.NODE_ENV = "production";
import { hostStorageServer } from "./storageServer";
import { getArg } from "./cliArgs";

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
    // Optional: hostStorageServer falls back to ~/cloudflare.json
    let cloudflareApiToken = getArg("cloudflareApiToken");
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
        cloudflareApiToken: cloudflareApiToken && { path: cloudflareApiToken } || undefined,
        lowSpaceThresholdBytes,
    });
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
