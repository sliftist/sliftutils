// Browser-side cross-tab write sync for BulkDatabase2, over BroadcastChannel (one channel per collection, same-origin tabs and workers). It does NOT persist anything — each side writes to disk itself; this just relays live writes to other open tabs/workers and, when one starts up, asks peers for writes they've made recently that may not be on disk yet. No-op in Node / where BroadcastChannel is unavailable, so BulkDatabase2 can call these unconditionally. This is an optional feature, so there is no fallback.

export type RemoteWrite = { key: string; time: number; deleted?: boolean; value?: unknown };

// Writes older than this are assumed already flushed to disk (a freshly-opened tab gets those by reading disk), so a tab only replays writes newer than this when a peer says hello.
const RECENT_WINDOW_MS = 60_000;

type Channel = {
    bc: BroadcastChannel;
    subscribers: ((write: RemoteWrite) => void)[];
    // Called when a peer asks everyone to seal (stop appending to) their current stream file.
    sealSubscribers: (() => void)[];
    // This tab's own recent writes, kept so it can answer another tab's "hello".
    recent: RemoteWrite[];
    // Writer ids that answered our most recent liveness probe.
    aliveReplies: Set<string>;
};

const channels = new Map<string, Channel>();

// The id this process stamps into its stream file names. Registered by BulkDatabase2 so we can answer a peer's liveness probe even on a channel that was created by a write rather than by connect().
let selfWriterId: string | undefined;

export function registerWriterId(id: string): void {
    selfWriterId = id;
}

export function isSyncSupported(): boolean {
    // window (main-thread browser) or WorkerGlobalScope (Web/Service/Shared worker) — but not Node (typesafecss's isNode is `typeof window === "undefined"`, which misclassifies workers)
    let isBrowserOrWorker = typeof window !== "undefined"
        || "WorkerGlobalScope" in globalThis;
    return isBrowserOrWorker && typeof BroadcastChannel !== "undefined";
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
    // BroadcastChannel never delivers a message back to the instance that sent it, so a tab never hears its own writes — only the other open tabs do.
    const bc = new BroadcastChannel(`bulkDatabase2:${collection}`);
    const created: Channel = { bc, subscribers: [], sealSubscribers: [], recent: [], aliveReplies: new Set() };
    bc.onmessage = (event: MessageEvent) => {
        const msg = event.data as { type: string; write?: RemoteWrite; writes?: RemoteWrite[]; writerId?: string };
        if (!msg) return;
        if (msg.type === "write" && msg.write) {
            deliver(created, msg.write);
        } else if (msg.type === "recent" && msg.writes) {
            for (const write of msg.writes) deliver(created, write);
        } else if (msg.type === "seal") {
            // A peer is about to fold recent data; stop appending to our current stream file so it becomes complete and the merge can fold it whole. Our next write starts a fresh file.
            for (const sub of created.sealSubscribers) sub();
        } else if (msg.type === "whoIsAlive") {
            if (selfWriterId) created.bc.postMessage({ type: "alive", writerId: selfWriterId });
        } else if (msg.type === "alive" && msg.writerId) {
            created.aliveReplies.add(msg.writerId);
        } else if (msg.type === "hello") {
            // Another tab just started; replay our recent writes so it doesn't miss any. The reply goes to every tab, but peers that already have a write ignore it (its timestamp isn't newer than what they hold), so the redundant broadcast is harmless.
            pruneRecent(created);
            if (created.recent.length) created.bc.postMessage({ type: "recent", writes: created.recent });
        }
    };
    channels.set(collection, created);
    return created;
}

// Subscribe to remote writes for a collection. Recent writes from already-open tabs arrive through the same onWrite callback (as the reply to our hello), so the returned array is always empty — it's kept only for API compatibility with callers that await it.
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

// Which writer ids are still running, so a merge can tell a stream file whose owner is gone (fold it now) from one that is still being appended to (leave it). Returns undefined where BroadcastChannel is unavailable (Node) — there we cannot know, so the caller must assume every owner is alive and fall back to the age rule.
//
// A peer that is frozen or too slow to answer inside timeoutMs looks dead. That is safe, not lossy: the fold writes the stream's rows into a bulk file before deleting the stream, and FileStorage.append recreates a deleted file and seeks to its LIVE size, so a late append starts a fresh file instead of resurrecting folded bytes.
export async function queryLiveWriters(collection: string, timeoutMs: number): Promise<Set<string> | undefined> {
    const channel = ensure(collection);
    if (!channel) return undefined;
    channel.aliveReplies.clear();
    channel.bc.postMessage({ type: "whoIsAlive" });
    await new Promise<void>(r => setTimeout(r, timeoutMs));
    return new Set(channel.aliveReplies);
}

// Ask every other open tab of this collection to seal (stop appending to) its current stream file, so a merge can fold recent data up to the present without racing an append. Best-effort: no-op in Node, and a peer that misses it just keeps appending — worst case the merge folds a prefix and the rest folds later (duplication, resolved by write-time), never data loss.
export function broadcastSeal(collection: string): void {
    const channel = ensure(collection);
    if (!channel) return;
    channel.bc.postMessage({ type: "seal" });
}
