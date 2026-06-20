import { isNode } from "typesafecss";
import type { DirectoryWrapper, FileWrapper } from "./FileFolderAPI";

// A remote server (remoteFileServer.js) exposed as a DirectoryWrapper — the SAME interface as the
// Node.js and File-System-Access handles. So getDirectoryHandle can return one of these and everything
// downstream (wrapHandle, navigation, BulkDatabase2) works unchanged; nothing else knows it's remote.
//
// Files here are immutable (written once) or append-only, so the range cache (raw compressed bytes, in
// ~1MB aligned chunks) is always valid — over the network latency dominates, so reading 1MB costs about
// the same as 64KB and far fewer round trips wins.

const EMPTY = Buffer.alloc(0);
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_CACHE_BYTES = 128 * 1024 * 1024;

export type RemoteOptions = {
    chunkBytes?: number;
    cacheBytes?: number;
    maxFetchBytes?: number;      // cap per read request; large reads split into this many bytes each
    latencyMs?: number;          // artificial per-request delay, for simulating network latency in tests
    stats?: { requestCount: number; bytesFetched: number };
};

function enoent(p: string): Error {
    return Object.assign(new Error(`File not found: ${p}`), { code: "ENOENT", name: "NotFoundError" });
}
function toArrayBuffer(b: Buffer): ArrayBuffer {
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type Stat = { size: number; lastModified: number; dir: boolean };

// A stat is cached this long, so the burst of size lookups during a single read pass is one request per
// file, not one per block. Short enough that an append by another writer shows up promptly; our own
// writes invalidate it immediately.
const INFO_TTL_MS = 2000;
// We keep at most this many bytes of read/write requests in flight at once (the rest queue), so a big
// read doesn't fire hundreds of MB of requests at the server simultaneously.
const MAX_INFLIGHT_BYTES = 64 * 1024 * 1024;
// A single read request fetches at most this much; large reads are split into this many concurrent
// requests (bounded by MAX_INFLIGHT_BYTES).
const DEFAULT_MAX_FETCH_BYTES = 4 * 1024 * 1024;
const STATS_LOG_INTERVAL_MS = 10 * 1000;
const RECV_WINDOW_MS = 60 * 1000;

function fmtBytes(n: number): string {
    if (n < 1024) return n + "B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + "GB";
}

// Minimal WebSocket surface common to the browser's WebSocket and the `ws` package.
type WSLike = {
    readyState: number;
    binaryType: string;
    send(data: Uint8Array): void;
    close(): void;
    onopen: (() => void) | null;
    onmessage: ((ev: { data: ArrayBuffer | Buffer }) => void) | null;
    onclose: (() => void) | null;
    onerror: ((e: unknown) => void) | null;
};
function makeWebSocket(url: string): WSLike {
    if (isNode()) {
        // `ws` is a Node dep; the eval hides it from the browser bundler (this branch never runs there).
        const WS = (eval("require") as NodeRequire)("ws");
        return new WS(url, { rejectUnauthorized: false }) as WSLike; // self-signed cert
    }
    return new WebSocket(url) as unknown as WSLike;
}

// Binary frame: [u32 headerLen LE][header JSON][body bytes].
function encodeFrame(header: object, body?: Buffer): Buffer {
    const h = Buffer.from(JSON.stringify(header), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(h.length, 0);
    return Buffer.concat([len, h, body || EMPTY]);
}
function decodeFrame(buf: Buffer): { header: any; body: Buffer } {
    const headerLen = buf.readUInt32LE(0);
    const header = JSON.parse(buf.subarray(4, 4 + headerLen).toString("utf8"));
    return { header, body: buf.subarray(4 + headerLen) };
}

type QueuedRequest = { id: number; frame: Buffer; bytes: number; resolve: (r: { status: number; body: Buffer }) => void; reject: (e: Error) => void };

// One WebSocket to a remote server, multiplexing all ops over it. Requests are queued and only sent
// while < MAX_INFLIGHT_BYTES are outstanding; every 10s (when there's traffic) it logs the queue depth
// and throughput.
class Connection {
    private cache: RangeCache;
    private infoCache = new Map<string, { stat: Stat | undefined; at: number }>();

    private ws: WSLike | undefined;
    private connecting: Promise<void> | undefined;
    private nextId = 1;
    private pending = new Map<number, { resolve: (r: { status: number; body: Buffer }) => void; reject: (e: Error) => void; bytes: number }>();
    private queue: QueuedRequest[] = [];
    private inFlightBytes = 0;

    private receivedTotal = 0;
    private recvWindow: { t: number; n: number }[] = [];
    private wsUrl: string;
    private host: string;
    private statsTimer: ReturnType<typeof setInterval>;

    constructor(public url: string, public password: string, private opts: RemoteOptions) {
        this.url = url.replace(/\/+$/, "");
        this.wsUrl = this.url.replace(/^http/, "ws"); // https→wss, http→ws
        this.host = (() => { try { return new URL(this.url).host; } catch { return this.url; } })();
        this.cache = new RangeCache(opts.chunkBytes || DEFAULT_CHUNK_BYTES, opts.cacheBytes || DEFAULT_CACHE_BYTES, opts.maxFetchBytes || DEFAULT_MAX_FETCH_BYTES);
        this.statsTimer = setInterval(() => this.logStats(), STATS_LOG_INTERVAL_MS);
        (this.statsTimer as { unref?: () => void }).unref?.();
    }

    close() {
        clearInterval(this.statsTimer);
        try { this.ws?.close(); } catch { /* */ }
        this.ws = undefined;
        this.connecting = undefined;
    }

    private logStats() {
        const now = Date.now();
        this.recvWindow = this.recvWindow.filter(e => now - e.t < RECV_WINDOW_MS);
        if (this.inFlightBytes === 0 && this.queue.length === 0) return; // only when there's traffic
        const recv60 = this.recvWindow.reduce((a, e) => a + e.n, 0);
        const queuedBytes = this.queue.reduce((a, q) => a + q.bytes, 0);
        console.log(`[remote ${this.host}] outstanding ${fmtBytes(this.inFlightBytes)} (${this.pending.size} req), queued ${fmtBytes(queuedBytes)} (${this.queue.length} req), recv/60s ${fmtBytes(recv60)}, recv total ${fmtBytes(this.receivedTotal)}`);
    }

    private ensureConnected(): Promise<void> {
        if (this.ws && this.ws.readyState === 1) return Promise.resolve();
        if (this.connecting) return this.connecting;
        this.connecting = new Promise<void>((resolve, reject) => {
            let authed = false;
            const ws = makeWebSocket(this.wsUrl);
            ws.binaryType = "arraybuffer";
            this.ws = ws;
            ws.onopen = () => ws.send(encodeFrame({ id: 0, op: "auth", password: this.password }));
            ws.onmessage = (ev) => {
                const buf = Buffer.isBuffer(ev.data) ? ev.data as Buffer : Buffer.from(ev.data as ArrayBuffer);
                const { header } = decodeFrame(buf);
                if (!authed && header.id === 0) {
                    if (header.status === 200) { authed = true; resolve(); }
                    else { reject(new Error("remote: authentication failed")); try { ws.close(); } catch { /* */ } }
                    return;
                }
                this.onMessage(buf);
            };
            ws.onerror = () => { if (!authed) reject(new Error("remote: websocket connection error")); };
            ws.onclose = () => {
                if (!authed) reject(new Error("remote: connection closed before authenticating"));
                this.handleDisconnect();
            };
        });
        // Let a failed connection be retried next time.
        this.connecting.catch(() => { this.ws = undefined; this.connecting = undefined; });
        return this.connecting;
    }

    private onMessage(buf: Buffer) {
        const { header, body } = decodeFrame(buf);
        const p = this.pending.get(header.id);
        if (!p) return;
        this.pending.delete(header.id);
        this.inFlightBytes -= p.bytes;
        this.receivedTotal += body.length;
        if (this.opts.stats) this.opts.stats.bytesFetched += body.length;
        this.recvWindow.push({ t: Date.now(), n: body.length });
        p.resolve({ status: header.status, body });
        this.drain();
    }

    private handleDisconnect() {
        const err = new Error("remote: websocket disconnected");
        for (const p of this.pending.values()) p.reject(err);
        for (const q of this.queue) q.reject(err);
        this.pending.clear();
        this.queue = [];
        this.inFlightBytes = 0;
        this.ws = undefined;
        this.connecting = undefined;
    }

    private drain() {
        while (this.queue.length && this.ws && this.ws.readyState === 1) {
            const next = this.queue[0];
            if (this.inFlightBytes > 0 && this.inFlightBytes + next.bytes > MAX_INFLIGHT_BYTES) break; // hold the queue
            this.queue.shift();
            this.inFlightBytes += next.bytes;
            this.pending.set(next.id, { resolve: next.resolve, reject: next.reject, bytes: next.bytes });
            if (this.opts.stats) this.opts.stats.requestCount++;
            this.ws.send(next.frame);
        }
    }

    // Sends one request over the WebSocket (queued + throttled). `bytes` is the expected payload size,
    // used for the in-flight cap.
    private async request(op: string, params: Record<string, unknown>, body: Buffer | undefined, bytes: number): Promise<{ status: number; body: Buffer }> {
        if (this.opts.latencyMs) await sleep(this.opts.latencyMs);
        await this.ensureConnected();
        const id = this.nextId++;
        const frame = encodeFrame({ id, op, ...params }, body);
        return new Promise((resolve, reject) => {
            this.queue.push({ id, frame, bytes: Math.max(bytes, body ? body.length : 0, 1), resolve, reject });
            this.drain();
        });
    }

    async stat(path: string): Promise<Stat | undefined> {
        const cached = this.infoCache.get(path);
        if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached.stat;
        const r = await this.request("info", { path }, undefined, 256);
        let stat: Stat | undefined;
        if (r.status === 404) stat = undefined;
        else if (r.status !== 200) throw new Error(`remote info failed (${r.status})`);
        else stat = JSON.parse(r.body.toString("utf8")) as Stat;
        this.infoCache.set(path, { stat, at: Date.now() });
        return stat;
    }
    async list(path: string): Promise<{ name: string; dir: boolean }[]> {
        const r = await this.request("list", { path }, undefined, 4096);
        if (r.status !== 200) throw new Error(`remote list failed (${r.status})`);
        return JSON.parse(r.body.toString("utf8"));
    }
    async read(path: string, start: number, end: number): Promise<Buffer> {
        return (await this.cache.read(this, path, start, end)) ?? EMPTY;
    }
    async readServer(path: string, start: number, end: number): Promise<Buffer | undefined> {
        const r = await this.request("read", { path, start, end }, undefined, end - start);
        if (r.status === 404) return undefined;
        if (r.status !== 200) throw new Error(`remote read failed (${r.status})`);
        return r.body;
    }
    async append(path: string, body: Buffer): Promise<void> {
        const r = await this.request("append", { path }, body, body.length);
        if (r.status !== 200) throw new Error(`remote append failed (${r.status})`);
        this.infoCache.delete(path); // append-only keeps existing bytes; only the size changed
    }
    async set(path: string, body: Buffer): Promise<void> {
        const r = await this.request("set", { path }, body, body.length);
        if (r.status !== 200) throw new Error(`remote set failed (${r.status})`);
        this.cache.invalidate(path);
        this.infoCache.delete(path);
    }
    async remove(path: string): Promise<void> {
        const r = await this.request("remove", { path }, undefined, 256);
        if (r.status !== 200) throw new Error(`remote remove failed (${r.status})`);
        this.cache.invalidate(path);
        this.infoCache.delete(path);
    }
}

// Caches the longest-known prefix of each aligned chunk per path. Valid because files are immutable or
// append-only (the bytes at an offset never change). It only does range reads — it doesn't care what
// the files are.
class RangeCache {
    private chunks = new Map<string, Buffer>(); // path + "" + chunkIndex, insertion-ordered (LRU)
    private bytes = 0;
    constructor(private chunkBytes: number, private budget: number, private maxFetchBytes: number) { }
    private key(path: string, c: number) { return path + "" + c; }
    private peek(path: string, c: number): Buffer | undefined {
        const k = this.key(path, c);
        const v = this.chunks.get(k);
        if (v) { this.chunks.delete(k); this.chunks.set(k, v); }
        return v;
    }
    private store(path: string, c: number, buf: Buffer) {
        const k = this.key(path, c);
        const ex = this.chunks.get(k);
        if (ex && ex.length >= buf.length) { this.chunks.delete(k); this.chunks.set(k, ex); return; }
        if (ex) this.bytes -= ex.length;
        this.chunks.delete(k);
        this.chunks.set(k, buf);
        this.bytes += buf.length;
        while (this.bytes > this.budget && this.chunks.size > 0) {
            const oldest = this.chunks.keys().next().value as string;
            this.bytes -= (this.chunks.get(oldest) as Buffer).length;
            this.chunks.delete(oldest);
        }
    }
    invalidate(path: string) {
        const prefix = path + "";
        for (const k of [...this.chunks.keys()]) if (k.startsWith(prefix)) { this.bytes -= (this.chunks.get(k) as Buffer).length; this.chunks.delete(k); }
    }
    async read(conn: Connection, path: string, start: number, end: number): Promise<Buffer | undefined> {
        if (end <= start) return EMPTY;
        const CHUNK = this.chunkBytes;
        const maxRunChunks = Math.max(1, Math.floor(this.maxFetchBytes / CHUNK));
        const firstChunk = Math.floor(start / CHUNK);
        const lastChunk = Math.floor((end - 1) / CHUNK);
        // Collect the chunks we don't have deeply enough into bounded contiguous runs (each <= maxFetchBytes).
        const runs: { from: number; to: number }[] = [];
        let runFrom = -1;
        for (let c = firstChunk; c <= lastChunk; c++) {
            const cStart = c * CHUNK;
            const needEnd = Math.min(end, cStart + CHUNK) - cStart;
            const have = this.peek(path, c);
            if (!have || have.length < needEnd) {
                if (runFrom < 0) runFrom = c;
                if (c - runFrom + 1 >= maxRunChunks) { runs.push({ from: runFrom, to: c }); runFrom = -1; }
            } else if (runFrom >= 0) {
                runs.push({ from: runFrom, to: c - 1 });
                runFrom = -1;
            }
        }
        if (runFrom >= 0) runs.push({ from: runFrom, to: lastChunk });
        // Fetch all runs concurrently; the connection's queue caps total in-flight bytes.
        let missingFile = false;
        await Promise.all(runs.map(async run => {
            const bytes = await conn.readServer(path, run.from * CHUNK, (run.to + 1) * CHUNK);
            if (bytes === undefined) { missingFile = true; return; }
            for (let c = run.from; c <= run.to; c++) {
                const off = (c - run.from) * CHUNK;
                if (off >= bytes.length) break;
                this.store(path, c, bytes.subarray(off, Math.min(off + CHUNK, bytes.length)));
            }
        }));
        if (missingFile) return undefined;
        const parts: Buffer[] = [];
        for (let c = firstChunk; c <= lastChunk; c++) {
            const cStart = c * CHUNK;
            const from = Math.max(start, cStart) - cStart;
            const to = Math.min(end, cStart + CHUNK) - cStart;
            const chunk = this.peek(path, c);
            if (!chunk || chunk.length < to) { if (chunk && chunk.length > from) parts.push(chunk.subarray(from, chunk.length)); break; }
            parts.push(chunk.subarray(from, to));
        }
        return parts.length === 1 ? parts[0] : Buffer.concat(parts);
    }
}

const joinPath = (base: string, key: string) => (base ? base + "/" + key : key);
const baseName = (p: string) => p.split("/").filter(Boolean).pop() || "";

class RemoteFileWrapper implements FileWrapper {
    // `stat` is supplied when the parent already statted us (avoids a second /info). `createIntent` means
    // this was opened with create:true, so a missing file reads as empty (it'll be created on write).
    constructor(private conn: Connection, private filePath: string, private stat?: Stat, private createIntent = false) { }
    // Mirror the native FileSystemFileHandle shape so code written against it works unchanged.
    readonly kind = "file" as const;
    get name() { return baseName(this.filePath); }
    async getFile() {
        let stat = this.stat ?? await this.conn.stat(this.filePath);
        if (!stat) {
            if (!this.createIntent) throw enoent(this.filePath);
            stat = { size: 0, lastModified: Date.now(), dir: false };
        }
        const conn = this.conn, filePath = this.filePath, size = stat.size;
        return {
            size, lastModified: stat.lastModified,
            async arrayBuffer() { return toArrayBuffer(await conn.read(filePath, 0, size)); },
            slice(start: number, end: number) {
                return { async arrayBuffer() { return toArrayBuffer(await conn.read(filePath, start, end)); } };
            },
        };
    }
    async getURL() {
        // HTTPS URL into the server's range-capable /media endpoint. The token rides in the query because a
        // <video>/<img> element can't send an Authorization header.
        return `${this.conn.url}/media?path=${encodeURIComponent(this.filePath)}&token=${encodeURIComponent(this.conn.password)}`;
    }
    async createWritable(config?: { keepExistingData?: boolean }) {
        const conn = this.conn, filePath = this.filePath, append = !!config?.keepExistingData;
        const chunks: Buffer[] = [];
        return {
            async seek() { /* the server appends to the end / overwrites the whole file; offset unused */ },
            async write(value: Buffer) { chunks.push(value); },
            async close() {
                const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
                if (append) await conn.append(filePath, body); else await conn.set(filePath, body);
            },
        };
    }
}

class RemoteDirectoryWrapper implements DirectoryWrapper {
    constructor(private conn: Connection, private dirPath: string) { }
    // Mirror the native FileSystemDirectoryHandle shape (name/kind/entries) so code written against the
    // native API — e.g. recursive walks using `handle.entries()` — works the same over the network.
    readonly kind = "directory" as const;
    readonly isRemote = true;
    get name() { return baseName(this.dirPath); }
    get fullPath() { return this.dirPath; }
    async removeEntry(key: string): Promise<void> {
        await this.conn.remove(joinPath(this.dirPath, key));
    }
    async getFileHandle(key: string, options?: { create?: boolean }): Promise<RemoteFileWrapper> {
        const p = joinPath(this.dirPath, key);
        if (options?.create) return new RemoteFileWrapper(this.conn, p, undefined, true);
        const stat = await this.conn.stat(p);                 // matches the File API: throw if missing
        if (!stat || stat.dir) throw enoent(p);
        return new RemoteFileWrapper(this.conn, p, stat, false);
    }
    async getDirectoryHandle(key: string, options?: { create?: boolean }): Promise<RemoteDirectoryWrapper> {
        const p = joinPath(this.dirPath, key);
        if (!options?.create) {
            const stat = await this.conn.stat(p);
            if (!stat || !stat.dir) throw enoent(p);
        }
        return new RemoteDirectoryWrapper(this.conn, p);       // dirs are created lazily on first write
    }
    // Each entry is itself a real handle (a sub-wrapper), so a recursive walk over .entries() keeps
    // working at every level — exactly like the native API.
    async *[Symbol.asyncIterator](): AsyncIterableIterator<[string, RemoteFileWrapper | RemoteDirectoryWrapper]> {
        const entries = await this.conn.list(this.dirPath);
        for (const e of entries) {
            const childPath = joinPath(this.dirPath, e.name);
            yield [e.name, e.dir ? new RemoteDirectoryWrapper(this.conn, childPath) : new RemoteFileWrapper(this.conn, childPath)];
        }
    }
    entries() { return this[Symbol.asyncIterator](); }
    keys() { return mapAsync(this[Symbol.asyncIterator](), ([name]) => name); }
    values() { return mapAsync(this[Symbol.asyncIterator](), ([, handle]) => handle); }
}

async function* mapAsync<T, U>(it: AsyncIterableIterator<T>, fn: (v: T) => U): AsyncIterableIterator<U> {
    for await (const v of it) yield fn(v);
}

// A DirectoryWrapper rooted at a remote server. Drop-in for the Node / File-API handles.
export function getRemoteDirectoryHandle(url: string, password: string, options: RemoteOptions = {}): DirectoryWrapper {
    return new RemoteDirectoryWrapper(new Connection(url, password, options), "");
}

export type RemoteConnectResult = { status: "ok" } | { status: "unauthorized" } | { status: "unreachable"; error: string };

// Verifies a server is reachable and the password works — by opening the WebSocket, authenticating, and
// listing the root. Distinguishes "connected" / "wrong password" / "couldn't reach it" (the last usually
// meaning the self-signed cert isn't trusted yet in the browser, since the socket just fails to open).
export async function testRemoteConnection(url: string, password: string, options: RemoteOptions = {}): Promise<RemoteConnectResult> {
    const conn = new Connection(url, password, options);
    try {
        await conn.list("");
        return { status: "ok" };
    } catch (e) {
        const msg = (e as Error)?.message || String(e);
        if (/auth/i.test(msg)) return { status: "unauthorized" };
        return { status: "unreachable", error: msg };
    } finally {
        conn.close();
    }
}
