import { isNode } from "typesafecss";

// SharedWorker that synchronizes BulkDatabase2 writes between tabs of the same origin. It does NOT
// persist anything (each tab still writes to disk itself); it just relays writes to other tabs and
// buffers the recent ones so a freshly-opened tab can catch writes that haven't been flushed to disk
// yet. Per collection it keeps the latest write per key, pruned to a short recency window (older
// writes are already on disk, so a new tab gets them from there).

type RemoteWrite = { key: string; time: number; deleted?: boolean; value?: unknown };
type Collection = { ports: Set<MessagePort>; recent: Map<string, RemoteWrite> };

const RECENT_WINDOW_MS = 60_000;
const collections = new Map<string, Collection>();

function getCollection(name: string): Collection {
    let c = collections.get(name);
    if (!c) {
        c = { ports: new Set(), recent: new Map() };
        collections.set(name, c);
    }
    return c;
}

function prune(c: Collection) {
    let cutoff = Date.now() - RECENT_WINDOW_MS;
    for (let [key, write] of c.recent) {
        if (write.time < cutoff) c.recent.delete(key);
    }
}

function post(port: MessagePort, message: unknown) {
    try {
        port.postMessage(message);
    } catch {
        // Port closed (tab gone); it'll be dropped on the next failed send.
    }
}

function main() {
    if (isNode()) return;
    (self as unknown as { onconnect: (e: MessageEvent) => void }).onconnect = (event: MessageEvent) => {
        let port = (event as unknown as { ports: MessagePort[] }).ports[0];
        port.onmessage = (ev: MessageEvent) => {
            let msg = ev.data as { type: string; collection: string } & RemoteWrite;
            let c = getCollection(msg.collection);
            if (msg.type === "hello") {
                c.ports.add(port);
                prune(c);
                port.postMessage({ type: "recent", collection: msg.collection, writes: [...c.recent.values()] });
            } else if (msg.type === "write") {
                prune(c);
                let existing = c.recent.get(msg.key);
                if (!existing || msg.time > existing.time) {
                    c.recent.set(msg.key, { key: msg.key, time: msg.time, deleted: msg.deleted, value: msg.value });
                }
                for (let other of c.ports) {
                    if (other !== port) post(other, msg);
                }
            }
        };
        port.start();
    };
}

main();
