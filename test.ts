import net from "net";
import { listPortMappings, forwardPort, getLocalInternalIP } from "socket-function/src/forwardPort";

const TEST_PORT = 5299;
const EXTERNAL_IP = "99.250.124.91";

function testConnect(host: string, port: number): Promise<string> {
    return new Promise(resolve => {
        let socket = net.connect({ host, port, timeout: 8000 });
        socket.on("connect", () => {
            socket.destroy();
            resolve("CONNECTED");
        });
        socket.on("timeout", () => {
            socket.destroy();
            resolve("TIMEOUT");
        });
        socket.on("error", e => resolve((e as { code?: string }).code || String(e)));
    });
}

async function main() {
    let lanIP = await getLocalInternalIP();
    console.log("our LAN IP:", lanIP);

    let listener = net.createServer(socket => {
        socket.on("error", () => socket.destroy());
        socket.end("hello");
    });
    await new Promise<void>(resolve => listener.listen(TEST_PORT, "0.0.0.0", () => resolve()));
    console.log(`listening on 0.0.0.0:${TEST_PORT}`);

    await forwardPort({ externalPort: TEST_PORT, internalPort: TEST_PORT });

    let mappings = await listPortMappings();
    let ours = mappings.find(x => x.externalPort === TEST_PORT);
    console.log(`mapping for ${TEST_PORT} after create:`, JSON.stringify(ours) || "MISSING");

    console.log(`LAN direct (${lanIP}:${TEST_PORT}):`, await testConnect(lanIP || "127.0.0.1", TEST_PORT));
    console.log(`hairpin (${EXTERNAL_IP}:${TEST_PORT}):`, await testConnect(EXTERNAL_IP, TEST_PORT));

    listener.close();
    process.exit(0);
}

main().catch(e => {
    console.error((e as Error).stack ?? e);
    process.exit(1);
});
