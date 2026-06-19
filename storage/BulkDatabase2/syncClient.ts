import { isNode } from "typesafecss";

// Browser-side cross-tab write sync for BulkDatabase2, over BroadcastChannel (one channel per
// collection, same-origin tabs). It does NOT persist anything — each tab writes to disk itself; this
// just relays live writes to other open tabs and, when a tab starts up, asks peers for writes they've
// made recently that may not be on disk yet. No-op in Node / where BroadcastChannel is unavailable, so
// BulkDatabase2 can call these unconditionally. This is an optional feature, so there is no fallback.

export type RemoteWrite = { key: string; time: number; deleted?: boolean; value?: unknown };

// Writes older than this are assumed already flushed to disk (a freshly-opened tab gets those by
// reading disk), so a tab only replays writes newer than this when a peer says hello.
const RECENT_WINDOW_MS = 60_000;

type Channel = {
    bc: BroadcastChannel;
    subscribers: ((write: RemoteWrite) => void)[];
    // Called when a peer asks everyone to seal (stop appending to) their current stream file.
    sealSubscribers: (() => void)[];
    // This tab's own recent writes, kept so it can answer another tab's "hello".
    recent: RemoteWrite[];
};

const channels = new Map<string, Channel>();

export function isSyncSupported(): boolean {
    return !isNode() && typeof BroadcastChannel !== "undefined";
}

function pruneRecent(channel: Channel) {
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    channel.recent = channel.recent.filter(w => w.time >= cutoff);
}

function deliver(channel: Channel, write: RemoteWrite) {
    for (const sub of channel.subscribers) sub(write);
}

function ensure(collection: string): Channel | undefined {
    if (!isSyncSupported()) return undefined;
    let channel = channels.get(collection);
    if (channel) return channel;
    // BroadcastChannel never delivers a message back to the instance that sent it, so a tab never
    // hears its own writes — only the other open tabs do.
    const bc = new BroadcastChannel(`bulkDatabase2:${collection}`);
    const created: Channel = { bc, subscribers: [], sealSubscribers: [], recent: [] };
    bc.onmessage = (event: MessageEvent) => {
        const msg = event.data as { type: string; write?: RemoteWrite; writes?: RemoteWrite[] };
        if (!msg) return;
        if (msg.type === "write" && msg.write) {
            deliver(created, msg.write);
        } else if (msg.type === "recent" && msg.writes) {
            for (const write of msg.writes) deliver(created, write);
        } else if (msg.type === "seal") {
            // A peer is about to fold recent data; stop appending to our current stream file so it
            // becomes complete and the merge can fold it whole. Our next write starts a fresh file.
            for (const sub of created.sealSubscribers) sub();
        } else if (msg.type === "hello") {
            // Another tab just started; replay our recent writes so it doesn't miss any. The reply goes
            // to every tab, but peers that already have a write ignore it (its timestamp isn't newer
            // than what they hold), so the redundant broadcast is harmless.
            pruneRecent(created);
            if (created.recent.length) created.bc.postMessage({ type: "recent", writes: created.recent });
        }
    };
    channels.set(collection, created);
    return created;
}

// Subscribe to remote writes for a collection. Recent writes from already-open tabs arrive through the
// same onWrite callback (as the reply to our hello), so the returned array is always empty — it's kept
// only for API compatibility with callers that await it.
export function connect(collection: string, onWrite: (write: RemoteWrite) => void, onSeal?: () => void): Promise<RemoteWrite[]> {
    const channel = ensure(collection);
    if (!channel) return Promise.resolve([]);
    channel.subscribers.push(onWrite);
    if (onSeal) channel.sealSubscribers.push(onSeal);
    channel.bc.postMessage({ type: "hello" });
    return Promise.resolve([]);
}

export function broadcast(collection: string, write: RemoteWrite): void {
    const channel = ensure(collection);
    if (!channel) return;
    channel.recent.push(write);
    pruneRecent(channel);
    channel.bc.postMessage({ type: "write", write });
}

// Ask every other open tab of this collection to seal (stop appending to) its current stream file, so
// a merge can fold recent data up to the present without racing an append. Best-effort: no-op in Node,
// and a peer that misses it just keeps appending — worst case the merge folds a prefix and the rest
// folds later (duplication, resolved by write-time), never data loss.
export function broadcastSeal(collection: string): void {
    const channel = ensure(collection);
    if (!channel) return;
    channel.bc.postMessage({ type: "seal" });
}
