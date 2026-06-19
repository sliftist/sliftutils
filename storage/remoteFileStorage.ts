import { isNode } from "typesafecss";
import https from "https";
import type { FileStorage, NestedFileStorage } from "./FileFolderAPI";

// Client for remoteFileServer.js: exposes a remote folder as a FileStorage (so BulkDatabase2 runs over
// the network unchanged). One HTTP round trip per operation. A pure data-level range cache (below)
// fetches in large aligned chunks and reuses them, because over the network latency dominates — reading
// 1MB costs about the same as 64KB, so fewer round trips wins.

const EMPTY = Buffer.alloc(0);

// Over the network, fetch reads in chunks this big and cache them. Big because each request pays a
// full round trip; over-reading a bit is far cheaper than another round trip.
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_CACHE_BYTES = 128 * 1024 * 1024;

export type RemoteFileStorageOptions = {
    // Bytes per cached chunk (aligned). Reads coalesce/serve from these.
    chunkBytes?: number;
    // Max total bytes held in the range cache (LRU eviction).
    cacheBytes?: number;
    // Artificial per-request delay, for simulating network latency in tests.
    latencyMs?: number;
};

type Connection = {
    url: string;
    password: string;
    latencyMs: number;
    agent: https.Agent | undefined;
    cache: RangeCache;
    // Observable stats (handy for tests / diagnostics).
    stats: { requestCount: number; bytesFetched: number };
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// One HTTP request. Node uses the https module (self-signed cert → verification disabled); the browser
// uses fetch (the user accepts the self-signed cert once). Returns the raw status + body bytes.
async function httpRequest(conn: Connection, method: string, op: string, params: Record<string, string>, body?: Buffer): Promise<{ status: number; body: Buffer }> {
    if (conn.latencyMs > 0) await sleep(conn.latencyMs);
    conn.stats.requestCount++;
    const qs = new URLSearchParams(params).toString();
    const fullUrl = conn.url.replace(/\/+$/, "") + op + (qs ? "?" + qs : "");
    const headers: Record<string, string> = { authorization: "Bearer " + conn.password };
    if (body) headers["content-type"] = "application/octet-stream";

    if (isNode()) {
        return await new Promise((resolve, reject) => {
            const u = new URL(fullUrl);
            const req = https.request({
                hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: conn.agent,
            }, res => {
                const chunks: Buffer[] = [];
                res.on("data", d => chunks.push(d as Buffer));
                res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
            });
            req.on("error", reject);
            if (body) req.write(body);
            req.end();
        });
    }
    const res = await fetch(fullUrl, { method, headers, body: body ? new Uint8Array(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: buf };
}

async function readRange(conn: Connection, path: string, start: number, end: number): Promise<Buffer | undefined> {
    const r = await httpRequest(conn, "GET", "/read", { path, start: String(start), end: String(end) });
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new Error(`remote read failed (${r.status}): ${r.body.toString("utf8").slice(0, 200)}`);
    conn.stats.bytesFetched += r.body.length;
    return r.body;
}

// Caches the longest-known prefix of each aligned chunk per path. Safe because every file here is either
// immutable (bulk files, written once under a unique name) or append-only (stream files): the bytes at a
// given offset never change, only more are added. So a cached [0, n) of a chunk is always valid; a read
// that needs MORE than we have refetches (and picks up appended bytes). It never distinguishes file
// types — it only does range reads.
class RangeCache {
    private chunks = new Map<string, Buffer>(); // key: path + "" + chunkIndex (insertion-ordered → LRU)
    private bytes = 0;
    constructor(private chunkBytes: number, private budget: number) { }

    private key(path: string, c: number) { return path + "" + c; }
    private peek(path: string, c: number): Buffer | undefined {
        const k = this.key(path, c);
        const v = this.chunks.get(k);
        if (v) { this.chunks.delete(k); this.chunks.set(k, v); } // bump to most-recent
        return v;
    }
    private store(path: string, c: number, buf: Buffer) {
        const k = this.key(path, c);
        const ex = this.chunks.get(k);
        if (ex && ex.length >= buf.length) { this.chunks.delete(k); this.chunks.set(k, ex); return; } // keep longer prefix
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
        for (const k of [...this.chunks.keys()]) {
            if (k.startsWith(prefix)) { this.bytes -= (this.chunks.get(k) as Buffer).length; this.chunks.delete(k); }
        }
    }

    async getRange(conn: Connection, path: string, start: number, end: number): Promise<Buffer | undefined> {
        if (end <= start) return EMPTY;
        const CHUNK = this.chunkBytes;
        const firstChunk = Math.floor(start / CHUNK);
        const lastChunk = Math.floor((end - 1) / CHUNK);
        // Find the contiguous span of chunks we don't have enough of, and fetch it in one request.
        let fetchFrom = -1, fetchTo = -1;
        for (let c = firstChunk; c <= lastChunk; c++) {
            const cStart = c * CHUNK;
            const needEnd = Math.min(end, cStart + CHUNK) - cStart;
            const have = this.peek(path, c);
            if (!have || have.length < needEnd) { if (fetchFrom < 0) fetchFrom = c; fetchTo = c; }
        }
        if (fetchFrom >= 0) {
            const bytes = await readRange(conn, path, fetchFrom * CHUNK, (fetchTo + 1) * CHUNK);
            if (bytes === undefined) return undefined; // file missing
            for (let c = fetchFrom; c <= fetchTo; c++) {
                const off = (c - fetchFrom) * CHUNK;
                if (off >= bytes.length) break; // hit EOF — no bytes for this chunk
                this.store(path, c, bytes.subarray(off, Math.min(off + CHUNK, bytes.length)));
            }
        }
        const parts: Buffer[] = [];
        for (let c = firstChunk; c <= lastChunk; c++) {
            const cStart = c * CHUNK;
            const from = Math.max(start, cStart) - cStart;
            const to = Math.min(end, cStart + CHUNK) - cStart;
            const chunk = this.peek(path, c);
            if (!chunk || chunk.length < to) {
                // File ended before the requested end — return what's available (callers read within EOF).
                if (chunk && chunk.length > from) parts.push(chunk.subarray(from, chunk.length));
                break;
            }
            parts.push(chunk.subarray(from, to));
        }
        return parts.length === 1 ? parts[0] : Buffer.concat(parts);
    }
}

function makeStorage(conn: Connection, basePath: string): FileStorage {
    const rel = (key: string) => basePath ? basePath + "/" + key : key;

    const folder: NestedFileStorage = {
        async hasKey(key: string): Promise<boolean> {
            const r = await httpRequest(conn, "GET", "/hasDir", { path: rel(key) });
            if (r.status !== 200) return false;
            return !!JSON.parse(r.body.toString("utf8")).exists;
        },
        async getStorage(key: string): Promise<FileStorage> {
            return makeStorage(conn, rel(key));
        },
        async removeStorage(key: string): Promise<void> {
            await httpRequest(conn, "DELETE", "/removeDir", { path: rel(key) });
            conn.cache.invalidate(rel(key));
        },
        async getKeys(): Promise<string[]> {
            const r = await httpRequest(conn, "GET", "/list", { path: basePath, folders: "1" });
            if (r.status !== 200) throw new Error(`remote list failed (${r.status})`);
            return JSON.parse(r.body.toString("utf8"));
        },
    };

    return {
        async getInfo(key: string) {
            const r = await httpRequest(conn, "GET", "/info", { path: rel(key) });
            if (r.status === 404) return undefined;
            if (r.status !== 200) throw new Error(`remote info failed (${r.status})`);
            return JSON.parse(r.body.toString("utf8")) as { size: number; lastModified: number };
        },
        async get(key: string) {
            const info = await this.getInfo(key);
            if (!info) return undefined;
            return this.getRange(key, { start: 0, end: info.size });
        },
        async getRange(key: string, config: { start: number; end: number }) {
            return conn.cache.getRange(conn, rel(key), config.start, config.end);
        },
        async append(key: string, value: Buffer) {
            const r = await httpRequest(conn, "PUT", "/append", { path: rel(key) }, value);
            if (r.status !== 200) throw new Error(`remote append failed (${r.status})`);
            // No invalidation needed: append-only files keep their prefix; a read past it refetches.
        },
        async set(key: string, value: Buffer) {
            const r = await httpRequest(conn, "PUT", "/set", { path: rel(key) }, value);
            if (r.status !== 200) throw new Error(`remote set failed (${r.status})`);
            conn.cache.invalidate(rel(key));
        },
        async remove(key: string) {
            await httpRequest(conn, "DELETE", "/remove", { path: rel(key) });
            conn.cache.invalidate(rel(key));
        },
        async getKeys(includeFolders: boolean = false) {
            const r = await httpRequest(conn, "GET", "/list", { path: basePath, folders: includeFolders ? "1" : "0" });
            if (r.status !== 200) throw new Error(`remote list failed (${r.status})`);
            return JSON.parse(r.body.toString("utf8"));
        },
        async reset() {
            await httpRequest(conn, "POST", "/reset", { path: basePath });
            conn.cache.invalidate(basePath);
        },
        folder,
    };
}

export type RemoteStorageFactory = ((path: string) => Promise<FileStorage>) & { stats: Connection["stats"] };

// Returns a StorageFactory (path -> FileStorage) backed by a remoteFileServer.js instance. Drop-in for
// getFileStorageNested2 in BulkDatabase2. `password` is the 6-word password the server printed.
export function getRemoteFileStorage(url: string, password: string, options: RemoteFileStorageOptions = {}): RemoteStorageFactory {
    const conn: Connection = {
        url,
        password,
        latencyMs: options.latencyMs || 0,
        // Self-signed cert: skip verification in Node. (The browser path uses fetch, where the user has
        // already accepted the cert.) The password is what authorizes access.
        agent: isNode() ? new https.Agent({ rejectUnauthorized: false }) : undefined,
        cache: new RangeCache(options.chunkBytes || DEFAULT_CHUNK_BYTES, options.cacheBytes || DEFAULT_CACHE_BYTES),
        stats: { requestCount: 0, bytesFetched: 0 },
    };
    const factory = ((path: string) => Promise.resolve(makeStorage(conn, path.replace(/^\/+|\/+$/g, "")))) as RemoteStorageFactory;
    factory.stats = conn.stats;
    return factory;
}
