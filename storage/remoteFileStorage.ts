import { isNode } from "typesafecss";
import https from "https";
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

class Connection {
    private agent = isNode() ? new https.Agent({ rejectUnauthorized: false }) : undefined;
    private cache: RangeCache;
    private infoCache = new Map<string, { stat: Stat | undefined; at: number }>();
    constructor(public url: string, public password: string, private opts: RemoteOptions) {
        this.cache = new RangeCache(opts.chunkBytes || DEFAULT_CHUNK_BYTES, opts.cacheBytes || DEFAULT_CACHE_BYTES);
        this.url = url.replace(/\/+$/, "");
    }

    // One HTTP request. Node uses the https module (self-signed cert → verification disabled); the
    // browser uses fetch (the user has accepted the cert). Returns the raw status + body bytes.
    async request(method: string, op: string, params: Record<string, string>, body?: Buffer): Promise<{ status: number; body: Buffer }> {
        if (this.opts.latencyMs) await sleep(this.opts.latencyMs);
        if (this.opts.stats) this.opts.stats.requestCount++;
        const qs = new URLSearchParams(params).toString();
        const fullUrl = this.url + op + (qs ? "?" + qs : "");
        const headers: Record<string, string> = { authorization: "Bearer " + this.password };
        if (body) headers["content-type"] = "application/octet-stream";
        if (isNode()) {
            return await new Promise((resolve, reject) => {
                const u = new URL(fullUrl);
                const req = https.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: this.agent }, res => {
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
        return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
    }

    async stat(path: string): Promise<Stat | undefined> {
        const cached = this.infoCache.get(path);
        if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached.stat;
        const r = await this.request("GET", "/info", { path });
        let stat: Stat | undefined;
        if (r.status === 404) stat = undefined;
        else if (r.status !== 200) throw new Error(`remote info failed (${r.status})`);
        else stat = JSON.parse(r.body.toString("utf8")) as Stat;
        this.infoCache.set(path, { stat, at: Date.now() });
        return stat;
    }
    async list(path: string): Promise<{ name: string; dir: boolean }[]> {
        const r = await this.request("GET", "/list", { path });
        if (r.status !== 200) throw new Error(`remote list failed (${r.status})`);
        return JSON.parse(r.body.toString("utf8"));
    }
    async read(path: string, start: number, end: number): Promise<Buffer> {
        return (await this.cache.read(this, path, start, end)) ?? EMPTY;
    }
    async readServer(path: string, start: number, end: number): Promise<Buffer | undefined> {
        const r = await this.request("GET", "/read", { path, start: String(start), end: String(end) });
        if (r.status === 404) return undefined;
        if (r.status !== 200) throw new Error(`remote read failed (${r.status})`);
        if (this.opts.stats) this.opts.stats.bytesFetched += r.body.length;
        return r.body;
    }
    async append(path: string, body: Buffer): Promise<void> {
        const r = await this.request("PUT", "/append", { path }, body);
        if (r.status !== 200) throw new Error(`remote append failed (${r.status})`);
        // Append-only keeps existing bytes, so cached chunks stay valid; just the size changed.
        this.infoCache.delete(path);
    }
    async set(path: string, body: Buffer): Promise<void> {
        const r = await this.request("PUT", "/set", { path }, body);
        if (r.status !== 200) throw new Error(`remote set failed (${r.status})`);
        this.cache.invalidate(path);
        this.infoCache.delete(path);
    }
    async remove(path: string): Promise<void> {
        const r = await this.request("DELETE", "/remove", { path });
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
    constructor(private chunkBytes: number, private budget: number) { }
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
        const firstChunk = Math.floor(start / CHUNK);
        const lastChunk = Math.floor((end - 1) / CHUNK);
        let fetchFrom = -1, fetchTo = -1;
        for (let c = firstChunk; c <= lastChunk; c++) {
            const cStart = c * CHUNK;
            const needEnd = Math.min(end, cStart + CHUNK) - cStart;
            const have = this.peek(path, c);
            if (!have || have.length < needEnd) { if (fetchFrom < 0) fetchFrom = c; fetchTo = c; }
        }
        if (fetchFrom >= 0) {
            const bytes = await conn.readServer(path, fetchFrom * CHUNK, (fetchTo + 1) * CHUNK);
            if (bytes === undefined) return undefined;
            for (let c = fetchFrom; c <= fetchTo; c++) {
                const off = (c - fetchFrom) * CHUNK;
                if (off >= bytes.length) break;
                this.store(path, c, bytes.subarray(off, Math.min(off + CHUNK, bytes.length)));
            }
        }
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

class RemoteFileWrapper implements FileWrapper {
    // `stat` is supplied when the parent already statted us (avoids a second /info). `createIntent` means
    // this was opened with create:true, so a missing file reads as empty (it'll be created on write).
    constructor(private conn: Connection, private filePath: string, private stat?: Stat, private createIntent = false) { }
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
    async removeEntry(key: string): Promise<void> {
        await this.conn.remove(joinPath(this.dirPath, key));
    }
    async getFileHandle(key: string, options?: { create?: boolean }): Promise<FileWrapper> {
        const p = joinPath(this.dirPath, key);
        if (options?.create) return new RemoteFileWrapper(this.conn, p, undefined, true);
        const stat = await this.conn.stat(p);                 // matches the File API: throw if missing
        if (!stat || stat.dir) throw enoent(p);
        return new RemoteFileWrapper(this.conn, p, stat, false);
    }
    async getDirectoryHandle(key: string, options?: { create?: boolean }): Promise<DirectoryWrapper> {
        const p = joinPath(this.dirPath, key);
        if (!options?.create) {
            const stat = await this.conn.stat(p);
            if (!stat || !stat.dir) throw enoent(p);
        }
        return new RemoteDirectoryWrapper(this.conn, p);       // dirs are created lazily on first write
    }
    async *[Symbol.asyncIterator](): AsyncIterableIterator<[string, { kind: "file"; name: string; getFile(): Promise<FileWrapper> } | { kind: "directory"; name: string; getDirectoryHandle(key: string, options?: { create?: boolean }): Promise<DirectoryWrapper> }]> {
        const entries = await this.conn.list(this.dirPath);
        for (const e of entries) {
            const childPath = joinPath(this.dirPath, e.name);
            if (e.dir) {
                yield [e.name, { kind: "directory", name: e.name, getDirectoryHandle: (k, o) => new RemoteDirectoryWrapper(this.conn, childPath).getDirectoryHandle(k, o) }];
            } else {
                yield [e.name, { kind: "file", name: e.name, getFile: async () => new RemoteFileWrapper(this.conn, childPath) }];
            }
        }
    }
}

// A DirectoryWrapper rooted at a remote server. Drop-in for the Node / File-API handles.
export function getRemoteDirectoryHandle(url: string, password: string, options: RemoteOptions = {}): DirectoryWrapper {
    return new RemoteDirectoryWrapper(new Connection(url, password, options), "");
}

export type RemoteConnectResult = { status: "ok" } | { status: "unauthorized" } | { status: "unreachable"; error: string };

// Verifies a server is reachable and the password works — by actually listing the root. Distinguishes
// "connected" / "wrong password" / "couldn't reach it" (the last usually meaning the self-signed cert
// isn't trusted yet in the browser, since fetch failures carry no detail).
export async function testRemoteConnection(url: string, password: string, options: RemoteOptions = {}): Promise<RemoteConnectResult> {
    const conn = new Connection(url, password, options);
    try {
        const r = await conn.request("GET", "/list", { path: "" });
        if (r.status === 200) return { status: "ok" };
        if (r.status === 401) return { status: "unauthorized" };
        return { status: "unreachable", error: `server returned ${r.status}` };
    } catch (e) {
        return { status: "unreachable", error: (e as Error)?.message || String(e) };
    }
}
