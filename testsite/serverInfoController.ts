import os from "os";
import { SocketFunction } from "socket-function/SocketFunction";

class ServerInfoControllerBase {
    // Innocuous server-only information, to prove the browser is really talking to the server
    async getServerOSName(): Promise<string> {
        return `${os.type()} ${os.release()} (${os.platform()})`;
    }
}

export const ServerInfoController = SocketFunction.register(
    "ServerInfoController-7f3b1c2a",
    new ServerInfoControllerBase(),
    () => ({
        getServerOSName: {},
    })
);
