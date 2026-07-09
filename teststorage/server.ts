process.env.NODE_ENV = "production";
import os from "os";
import path from "path";
import { SocketFunction } from "socket-function/SocketFunction";
import { RequireController } from "socket-function/require/RequireController";
import { hostServer } from "../misc/https/hostServer";
// Import browser code, so it is allowed to be required by the client
import "./browser";

// Static test site for the remote storage system (storage/remoteStorage). The browser talks to
// the storage server directly, so this server only serves the page.

const DOMAIN = "stest.vidgridweb.com";
const PORT = 4445;

process.on("unhandledRejection", (error) => {
    console.error("Unhandled promise rejection:", error);
});
process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});

async function main() {
    RequireController.allowAllNodeModules();
    SocketFunction.expose(RequireController);
    SocketFunction.setDefaultHTTPCall(RequireController, "requireHTML", {
        requireCalls: ["./teststorage/browser.tsx"],
    });
    RequireController.addStaticRoot(path.resolve("."));

    await hostServer({
        domain: DOMAIN,
        port: PORT,
        cloudflareApiTokenPath: os.homedir() + "/vidgridweb.com.key",
        setDNSRecord: true,
    });
    console.log(`Storage test site running at https://${DOMAIN}:${PORT}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
