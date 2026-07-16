process.env.NODE_ENV = "production";
import os from "os";
import { hostStorageServer } from "../storage/remoteStorage/storageServer";

// Entry point for the test storage server (teststorage/server.ts hosts the test SITE, which talks
// to this). A separate process, because socket-function's default HTTP call is process-global: the
// test site's page and the storage server's access page can't both be the default in one process.

const URL = "https://storage.vidgridweb.com:4444/storagerouting.json";
const FOLDER = os.homedir() + "/storageData";

process.on("unhandledRejection", (error) => {
    console.error("Unhandled promise rejection:", error);
});
process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});

hostStorageServer({
    url: URL,
    folder: FOLDER,
    cloudflareApiToken: { path: os.homedir() + "/vidgridweb.com.key" },
}).catch(e => {
    console.error(e);
    process.exit(1);
});
