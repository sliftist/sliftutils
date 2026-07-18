process.env.NODE_ENV = "production";
import path from "path";
import { SocketFunction } from "socket-function/SocketFunction";
import { RequireController } from "socket-function/require/RequireController";
import { hostServer } from "../misc/https/hostServer";
import { ServerInfoController } from "./serverInfoController";
// Import browser code, so it is allowed to be required by the client
import "./browser";

const DOMAIN = "testsite.vidgridweb.com";
const PORT = 4443;

process.on("unhandledRejection", (error) => {
    console.error("Unhandled promise rejection:", error);
});
process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});

async function main() {
    RequireController.allowAllNodeModules();
    SocketFunction.expose(RequireController);
    SocketFunction.expose(ServerInfoController);
    SocketFunction.setDefaultHTTPCall(RequireController, "requireHTML", {
        requireCalls: ["./testsite/browser.tsx"],
    });
    RequireController.addStaticRoot(path.resolve("."));

    await hostServer({
        domain: DOMAIN,
        port: PORT,
        setDNSRecord: true,
    });
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
