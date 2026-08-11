import http from "http";
import { verifyTrustPacket } from "./identity";
import { isMachineAccepted } from "./machines";

// A demonstration of machine trust, and the smallest thing that exercises it end to end: a client
// proves which machine it is, and this answers whether that machine is trusted from the address it
// is actually talking from.
//
// Plain http on purpose. Nothing here is secret - the packet proves who the client is by signature
// rather than by the channel, and the answer is a yes or no about a machine the caller already
// knows the id of.
const DEFAULT_PORT = 47812;
const TRUST_PATH = "/trusted";
const MAX_BODY_LENGTH = 64 * 1024;

/** The address the client is actually talking from. Not read from anything the client sent,
    because that is the one half of the pair it must not get to choose. */
function addressOf(request: http.IncomingMessage) {
    let address = request.socket.remoteAddress || "";
    // Node reports IPv4 over a dual stack socket this way.
    return address.replace(/^::ffff:/, "");
}

async function readBody(request: http.IncomingMessage) {
    let chunks: Buffer[] = [];
    let length = 0;
    for await (let chunk of request) {
        length += chunk.length;
        if (length > MAX_BODY_LENGTH) {
            throw new Error(`Expected at most ${MAX_BODY_LENGTH} bytes, was more`);
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

export function startTrustServer(config: { port: number }) {
    let server = http.createServer((request, response) => {
        let answer = async () => {
            if (request.url !== TRUST_PATH) {
                return { status: 404, body: { error: `POST a trust packet to ${TRUST_PATH}` } };
            }
            let packet = JSON.parse(await readBody(request));
            let ip = addressOf(request);
            let verified = verifyTrustPacket(packet);
            if (!verified.valid) {
                // Not a rejection of the machine, a packet that does not prove anything about one.
                return { status: 400, body: { trusted: false, ip, reason: verified.problem } };
            }
            let verdict = await isMachineAccepted({ machineId: packet.machineId, ip });
            return {
                status: 200,
                body: {
                    trusted: verdict.accepted,
                    machineId: packet.machineId,
                    ip,
                    // Whatever the check itself said. It is the only thing that knows which of the
                    // ways to be refused this was.
                    reason: verdict.reason,
                },
            };
        };
        answer().then(result => {
            console.log(`${request.method} ${request.url} from ${addressOf(request)}: ${JSON.stringify(result.body)}`);
            response.writeHead(result.status, { "Content-Type": "application/json" });
            response.end(JSON.stringify(result.body, undefined, 4));
        }).catch(e => {
            console.log(`${request.method} ${request.url} from ${addressOf(request)} failed. ${e}`);
            response.writeHead(500, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ trusted: false, error: `${e}` }, undefined, 4));
        });
    });
    server.listen(config.port);
    return server;
}

export async function main() {
    let port = Number(process.argv[2] || DEFAULT_PORT);
    if (!Number.isFinite(port)) {
        throw new Error(`Usage: yarn machineserver [port]`);
    }
    startTrustServer({ port });
    console.log(`Answering trust checks on http://0.0.0.0:${port}${TRUST_PATH}`);
    console.log(`A client asks with: yarn machineclient http://<this machine>:${port}`);
    // Left running. Nothing else to do here, the server is the program.
    await new Promise(() => { });
}
