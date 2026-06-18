// Browser-side client for the BulkDatabase2 SharedWorker (syncWorker). One SharedWorker connection
// per tab, multiplexed across collections. No-op when SharedWorker is unavailable (Node / unsupported
// browsers), so BulkDatabase2 can call these unconditionally.

export type RemoteWrite = { key: string; time: number; deleted?: boolean; value?: unknown };

// Path the worker bundle is served from (alongside the page bundles).
const WORKER_URL = "/syncWorker.js";

let port: MessagePort | undefined;
let initialized = false;
const subscribers = new Map<string, ((write: RemoteWrite) => void)[]>();
const recentResolvers = new Map<string, ((writes: RemoteWrite[]) => void)[]>();

export function isSyncSupported(): boolean {
    return typeof SharedWorker !== "undefined";
}

function ensure() {
    if (initialized) return;
    initialized = true;
    if (!isSyncSupported()) return;
    let worker = new SharedWorker(WORKER_URL);
    port = worker.port;
    port.onmessage = (ev: MessageEvent) => {
        let msg = ev.data as { type: string; collection: string; writes?: RemoteWrite[] } & RemoteWrite;
        if (msg.type === "recent") {
            let resolvers = recentResolvers.get(msg.collection) || [];
            recentResolvers.set(msg.collection, []);
            for (let resolve of resolvers) resolve(msg.writes || []);
        } else if (msg.type === "write") {
            for (let cb of subscribers.get(msg.collection) || []) cb(msg);
        }
    };
    port.start();
}

// Subscribe to remote writes for a collection and return the worker's buffered recent writes (so we
// catch writes another tab broadcast but hasn't flushed to disk yet).
export function connect(collection: string, onWrite: (write: RemoteWrite) => void): Promise<RemoteWrite[]> {
    ensure();
    if (!port) return Promise.resolve([]);
    let subs = subscribers.get(collection);
    if (!subs) { subs = []; subscribers.set(collection, subs); }
    subs.push(onWrite);
    return new Promise(resolve => {
        let resolvers = recentResolvers.get(collection);
        if (!resolvers) { resolvers = []; recentResolvers.set(collection, resolvers); }
        resolvers.push(resolve);
        port!.postMessage({ type: "hello", collection });
    });
}

export function broadcast(collection: string, write: RemoteWrite) {
    ensure();
    if (!port) return;
    port.postMessage({ type: "write", collection, key: write.key, time: write.time, deleted: write.deleted, value: write.value });
}
