import { SocketFunction } from "socket-function/SocketFunction";
import { SocketFunctionHook } from "socket-function/SocketFunctionTypes";
import { getNodeIdIP } from "socket-function/src/nodeCache";
import { setHTTPResultHeaders, getCurrentHTTPRequest } from "socket-function/src/callHTTPHandler";
import { performLocalCall } from "socket-function/src/callManager";
import { RequireController } from "socket-function/require/RequireController";
import { timeInMinute } from "socket-function/src/misc";
import { getCommonName, getMachineId, getOwnMachineId, validateCertificate, verify } from "../../misc/https/certs";
import { ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, FindConfig, SourceConfig, IMMUTABLE_CACHE_TIME } from "../IArchives";
import { ROUTING_FILE, getRoute, routeContains } from "./remoteConfig";
import {
    findBucketStore, getStore, getBucketStores, readBucketInternal, writeRoutingConfig,
    getBucketArchivesConfig, bucketSyncStatus, debugBucketIndexTotals, ActiveBucketInfo,
    debugListAccountBuckets, ServerBucketInfo,
    debugGetActiveBucket, activateBucket, getActiveBucketKeys,
} from "./storageServerState";
import { debugClearAccountWriteStats } from "./accessStats";
import { getStorageServerConfig, assertWritesAllowed } from "./serverConfig";
import { getTrustedMachines, isMachineAccepted, MachineState } from "../../security/machines/machines";
import { BlobStore } from "./blobStore";
import { getRoutingFileResult } from "./bucketDisk";
import { StorageClientController } from "./storageClientController";
import { trackAccess, trackAccessCall, getAccessTotals, readAccessSummaries, clearAccountAccessStats, AccessTotals, AccessSummaryState } from "./accessStats";
import { logMutation, listStorageLogFiles, readStorageLogFile } from "./storageLogs";
import { LogFileInfo } from "../StreamingLogs";
import { assertValidName, assertValidPath, assertValidArgs } from "./validation";
import type { SummaryEntry } from "../../treeSummary";

export const REMOTE_STORAGE_CLASS_GUID = "RemoteStorageController-b7e42a91";
export const STORAGE_AUTH_PURPOSE = "remoteStorage-auth-1";
export const STORAGE_NOT_AUTHENTICATED = "REMOTE_STORAGE_NOT_AUTHENTICATED_cf2f7b1e";
export const STORAGE_ACCESS_DENIED = "REMOTE_STORAGE_ACCESS_DENIED_9d81a4c0";

const AUTH_TIME_WINDOW = timeInMinute * 10;
const ACCESS_CHECK_SLOW_TIME = 50;
const MAX_SESSIONS = 100 * 1000;
const MAX_REQUESTS_PER_IP = 50;

export type AuthTokenData = {
    purpose: string;
    time: number;
    server: string;
};
export type AuthToken = {
    certPem: string;
    issuerPem: string;
    signature: string;
    data: AuthTokenData;
};
export type AccessState = {
    machineId: string;
    ip: string;
    hasAccess: boolean;
    // Why not, and what to run about it, when there is no access.
    reason?: string;
    addMachineCommand?: string;
    // Everything the repo trusts, when there is.
    trustedMachines?: MachineState[];
};

const sessions = new Map<string, string>();

// We must never serve anything that can be evaluated as code (html, js - and svg, which can embed <script> and runs it when visited as a document). Otherwise a user could host a file and, by visiting it, run it on our domain - giving them access to all of our keys and cookies. PDF stays: browser PDF viewers run any embedded PDF scripting in a sandbox with no access to the serving origin's cookies or DOM.
const CONTENT_TYPES: { [ext: string]: string } = {
    css: "text/css; charset=utf-8", json: "application/json; charset=utf-8",
    txt: "text/plain; charset=utf-8", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", mp4: "video/mp4", webm: "video/webm",
    mp3: "audio/mpeg", wav: "audio/wav", pdf: "application/pdf",
};

const connectedClients = new Set<string>();
function trackCaller(): void {
    let nodeId = SocketFunction.getCaller().nodeId;
    if (connectedClients.has(nodeId)) return;
    connectedClients.add(nodeId);
    SocketFunction.onNextDisconnect(nodeId, () => {
        connectedClients.delete(nodeId);
    });
}

export function broadcastRoutingChanged(): void {
    console.log(`Broadcasting routing config change to ${connectedClients.size} connected clients`);
    for (let nodeId of [...connectedClients]) {
        void StorageClientController.nodes[nodeId].routingConfigChanged().catch(() => { });
    }
}

function getCallerMachineId(): string {
    let caller = SocketFunction.getCaller();
    let machineId = sessions.get(caller.nodeId);
    if (!machineId) {
        throw new Error(`${STORAGE_NOT_AUTHENTICATED} Call authenticate first (connection ${caller.nodeId})`);
    }
    return machineId;
}
function getCallerIP(): string {
    return getNodeIdIP(SocketFunction.getCaller().nodeId);
}
function isAdmin(machineId: string): boolean {
    return machineId === getOwnMachineId(getStorageServerConfig().rootDomain);
}
function requireAdmin(): string {
    let machineId = getCallerMachineId();
    if (!isAdmin(machineId)) {
        throw new Error(`${STORAGE_ACCESS_DENIED} Admin commands must be run from the storage machine itself (caller machine ${machineId})`);
    }
    return machineId;
}
/** Who may talk to this server, decided by the signed authorized_keys repo rather than by anything
    this server keeps for itself.

    The identity is the same machine id it always was - a machine that was trusted here before is
    trusted the moment its id is in the repo - but the record of who is trusted now lives in one
    signed place shared by every machine, with revocation and everything else that comes with it.
    The address is checked too, which the trust store here never did. */
async function requireAccess(account: string): Promise<string> {
    assertValidName(account, "account");
    let machineId = getCallerMachineId();
    if (isAdmin(machineId)) return machineId;
    let { rootDomain } = getStorageServerConfig();
    let ip = getCallerIP();
    let verdict = await isMachineAccepted({ machineId, ip, domain: rootDomain });
    if (!verdict.accepted) {
        throw new Error(
            `${STORAGE_ACCESS_DENIED} ${verdict.reason}`
            + ` Machine ${machineId}, address ${ip}, account ${JSON.stringify(account)}.`
        );
    }
    return machineId;
}

class RemoteStorageControllerBase {
    async ping(): Promise<{}> {
        trackCaller();
        return {};
    }

    async authenticate(token: AuthToken): Promise<{ machineId: string; ip: string }> {
        let { domain, port, rootDomain } = getStorageServerConfig();
        let caller = SocketFunction.getCaller();
        verify(token.certPem, token.signature, token.data);
        let { purpose, time, server } = token.data;
        if (purpose !== STORAGE_AUTH_PURPOSE) {
            throw new Error(`Auth token purpose is ${JSON.stringify(purpose)}, expected ${JSON.stringify(STORAGE_AUTH_PURPOSE)}`);
        }
        if (Math.abs(Date.now() - time) > AUTH_TIME_WINDOW) {
            throw new Error(`Auth token time is too far from the server time (token ${time}, server ${Date.now()}, allowed drift ${AUTH_TIME_WINDOW}ms)`);
        }
        let tokenDomain = server.split(":")[0];
        if (tokenDomain !== domain) {
            throw new Error(`Auth token is for server ${JSON.stringify(server)}, but this server is ${JSON.stringify(`${domain}:${port}`)}`);
        }
        validateCertificate(rootDomain, token.certPem, token.issuerPem);
        let machineId = getMachineId(getCommonName(token.issuerPem), rootDomain);
        sessions.set(caller.nodeId, machineId);
        while (sessions.size > MAX_SESSIONS) {
            let oldest = sessions.keys().next().value;
            if (oldest === undefined) break;
            sessions.delete(oldest);
        }
        return { machineId, ip: getCallerIP() };
    }

    /** Whether the caller may use this account, and if not, exactly what to run to change that.

        There is nothing to request and nothing to grant here any more: trust lives in the signed
        authorized_keys repo, so the answer is "run addmachine in that repo", which only somebody
        holding the hardware key can do. */
    @assertValidArgs
    async getAccessState(config: { account: string }): Promise<AccessState> {
        assertValidName(config.account, "account");
        let machineId = getCallerMachineId();
        let ip = getCallerIP();
        let { rootDomain } = getStorageServerConfig();
        if (isAdmin(machineId)) {
            return { machineId, ip, hasAccess: true, trustedMachines: await getTrustedMachines() };
        }
        let verdict = await isMachineAccepted({ machineId, ip, domain: rootDomain });
        if (!verdict.accepted) {
            return {
                machineId,
                ip,
                hasAccess: false,
                reason: verdict.reason,
                addMachineCommand: `yarn addmachine ${rootDomain} ${machineId} ${ip} git`,
            };
        }
        return { machineId, ip, hasAccess: true, trustedMachines: await getTrustedMachines() };
    }

    /** Admin (so only this machine's own processes can call it): the buckets this process has loaded. A deploy successor asks its predecessor for this, so it activates exactly the buckets that are in use instead of every bucket on disk. */
    async adminListActiveBuckets(): Promise<{ account: string; bucketName: string }[]> {
        return getActiveBucketKeys();
    }

    @assertValidArgs
    @trackAccessCall("get")
    async get2(config: { account: string; bucketName: string; path: string; sourceConfig: SourceConfig; range?: { start: number; end: number }; internal?: boolean; includeTombstones?: boolean; includeMarked?: boolean }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        if (config.path === ROUTING_FILE) {
            // The routing file lives outside every store and even outside the bucket (it is what CREATES it), so it is read straight off the disk - absent means undefined, exactly like any file read
            return await getRoutingFileResult(config.account, config.bucketName);
        }
        if (config.internal) {
            return await readBucketInternal(config.account, config.bucketName, config);
        }
        return await withStore(config, store => store.get2(config));
    }
    @assertValidArgs
    @trackAccessCall("set")
    async set(config: { account: string; bucketName: string; path: string; data: Buffer; sourceConfig: SourceConfig; lastModified?: number; forceSetImmutable?: boolean; internal?: boolean; undelete?: boolean }): Promise<void> {
        assertWritesAllowed();
        let caller = callerId();
        // Copied because the wire hands us a plain Uint8Array view, not a real Buffer
        let data = Buffer.from(config.data);
        if (config.path === ROUTING_FILE) {
            // The store the caller selected owns this file: it applies it, enforces the version rule, and its peers pull it from there
            return await writeRoutingConfig(config.account, config.bucketName, config.sourceConfig.name, data, config);
        }
        await withStore(config, store => store.set({ ...config, data }));
        logMutation({ op: config.undelete && "undelete" || "set", account: config.account, bucketName: config.bucketName, store: config.sourceConfig.name, path: config.path, size: data.length, writeTime: config.lastModified, callerId: caller, internal: config.internal });
    }
    @assertValidArgs
    @trackAccessCall("del")
    async del(config: { account: string; bucketName: string; path: string; sourceConfig: SourceConfig; lastModified?: number; internal?: boolean }): Promise<void> {
        assertWritesAllowed();
        let caller = callerId();
        await withStore(config, store => store.del(config));
        logMutation({ op: "del", account: config.account, bucketName: config.bucketName, store: config.sourceConfig.name, path: config.path, writeTime: config.lastModified, callerId: caller, internal: config.internal });
    }
    @assertValidArgs
    @trackAccessCall("move")
    async move(config: { account: string; bucketName: string; fromPath: string; toPath: string; sourceConfig: SourceConfig }): Promise<void> {
        assertWritesAllowed();
        let caller = callerId();
        // assertValidArgs only knows the well-known `path` field, so the two paths of a move are validated here
        assertValidPath(config.fromPath);
        assertValidPath(config.toPath);
        await withStore(config, store => store.move(config));
        logMutation({ op: "move", account: config.account, bucketName: config.bucketName, store: config.sourceConfig.name, path: config.fromPath, toPath: config.toPath, callerId: caller });
    }
    @assertValidArgs
    @trackAccessCall("getInfo")
    async getInfo(config: { account: string; bucketName: string; path: string; sourceConfig: SourceConfig; includeTombstones?: boolean }): Promise<{ writeTime: number; size: number } | undefined> {
        if (config.path === ROUTING_FILE) {
            let result = await getRoutingFileResult(config.account, config.bucketName);
            return result && { writeTime: result.writeTime, size: result.size } || undefined;
        }
        return await withStore(config, store => store.getInfo(config));
    }
    @assertValidArgs
    @trackAccessCall("findInfo")
    async findInfo(config: FindConfig & { account: string; bucketName: string; prefix: string; sourceConfig: SourceConfig }): Promise<ArchiveFileInfo[]> {
        return await withStore(config, store => store.findInfo(config));
    }
    @assertValidArgs
    @trackAccessCall("getChangesAfter")
    async getChangesAfter2(config: { account: string; bucketName: string; sourceConfig: SourceConfig; time: number; routes?: [number, number][]; internal?: boolean }): Promise<ArchiveFileInfo[]> {
        return await withStore(config, store => store.getChangesAfter2(config));
    }
    @assertValidArgs
    async getArchivesConfig(config: { account: string; bucketName: string }): Promise<ArchivesConfig> {
        return await getBucketArchivesConfig(config.account, config.bucketName);
    }
    @assertValidArgs
    async listBuckets(config: { account: string }): Promise<ServerBucketInfo[]> {
        let start = Date.now();
        try {
            return await debugListAccountBuckets(config.account);
        } finally {
            // The access hook (and the storage it initializes) runs before this, so a large gap between this and the caller's timing is the hook
            console.log(`listBuckets(${config.account}) call body took ${Date.now() - start}ms`);
        }
    }
    /** The live, in-memory state of one bucket, or a string saying why it is unavailable. Answered without touching the disk, so it is cheap - but only works while the bucket is loaded here. */
    @assertValidArgs
    async getActiveBucket(config: { account: string; bucketName: string }): Promise<ActiveBucketInfo | string> {
        return await debugGetActiveBucket(config.account, config.bucketName);
    }
    /** Loads a bucket that exists on this server into memory (starting its synchronization) and returns its live state, or a string saying why it could not be loaded. */
    @assertValidArgs
    async activateBucket(config: { account: string; bucketName: string }): Promise<ActiveBucketInfo | string> {
        return await activateBucket(config.account, config.bucketName);
    }
    /** Zeroes the write statistics listBuckets reports and the in-memory access statistics, for every bucket in the account. */
    @assertValidArgs
    async clearWriteStats(config: { account: string }): Promise<{ clearedBuckets: number }> {
        clearAccountAccessStats(config.account);
        return { clearedBuckets: debugClearAccountWriteStats(config.account) };
    }
    /** In-memory totals per operation type since startup (or the last clearWriteStats). */
    @assertValidArgs
    async getAccessStats(config: { account: string }): Promise<AccessTotals> {
        return getAccessTotals(config.account);
    }
    /** A path breakdown of one operation's accesses (operation names come from getAccessStats). maxCount is passed straight to TreeSummary.getSummaries. weightBySize is ignored for count-only operations, which return their count breakdown. */
    @assertValidArgs
    async getAccessSummaries(config: { account: string; operation: string; maxCount: number; weightBySize?: boolean }): Promise<SummaryEntry<AccessSummaryState>[]> {
        return readAccessSummaries(config);
    }
    @assertValidArgs
    async getIndexInfo(config: { account: string; bucketName: string }): Promise<{ fileCount: number; byteCount: number; sources: { debugName: string; fileCount: number; byteCount: number }[] } | undefined> {
        return await debugBucketIndexTotals(config.account, config.bucketName);
    }
    @assertValidArgs
    async getSyncStatus(config: { account: string; bucketName: string }): Promise<ArchivesSyncStatus> {
        return await bucketSyncStatus(config.account, config.bucketName);
    }

    /** The operation-log files THIS server holds (every server logs its own operations - ask each one; see listAllServerLogFiles in createArchives). */
    @assertValidArgs
    async listLogFiles(config: { account: string }): Promise<LogFileInfo[]> {
        return await listStorageLogFiles();
    }
    /** One log file's bytes, always LZ4-compressed (a live file is flushed and compressed in memory before sending). Decode with decodeLogFile. */
    @assertValidArgs
    async getLogFile(config: { account: string; name: string }): Promise<Buffer> {
        return await readStorageLogFile(config.name);
    }

    @assertValidArgs
    async startLargeFile(config: { account: string; bucketName: string; path: string; sourceConfig: SourceConfig; lastModified?: number; forceSetImmutable?: boolean; noChecks?: boolean; internal?: boolean }): Promise<string> {
        assertWritesAllowed();
        let store = findBucketStore(config.account, config.bucketName, config.sourceConfig);
        // The store validates the write here, before any bytes move (see BlobStore.startLargeUpload) - a large file is a set, and its SetConfig decides whether it is even allowed
        let write = { path: config.path, lastModified: config.lastModified, forceSetImmutable: config.forceSetImmutable, noChecks: config.noChecks, internal: config.internal };
        let id = await store.startLargeUpload(write);
        // The store name pins the upload's parts and finish to the same store the start picked (in-flight uploads survive a bucket rebuild: the part data lives in that store's folder, which a rebuilt store still opens)
        largeUploadInfo.set(id, { ...write, account: config.account, bucketName: config.bucketName, storeName: config.sourceConfig.name });
        return id;
    }
    /** offset makes the part write positional (see ArchivesDisk.appendLargeUpload), which is what lets the client RETRY a failed part - a re-sent part lands on the same bytes instead of appending twice. */
    async uploadPart(config: { uploadId: string; data: Buffer; offset?: number }): Promise<void> {
        assertWritesAllowed();
        let info = largeUploadInfo.get(config.uploadId);
        if (!info) throw new Error(`Unknown large upload ${config.uploadId}`);
        trackAccess({ account: info.account, operation: "uploadPart", path: `${info.bucketName}/${info.path}`, size: config.data.length });
        await getStore(info.account, info.bucketName, info.storeName).appendLargeUpload({ id: config.uploadId, data: Buffer.from(config.data), offset: config.offset });
    }
    async finishLargeFile(config: { uploadId: string }): Promise<void> {
        assertWritesAllowed();
        let info = largeUploadInfo.get(config.uploadId);
        if (!info) throw new Error(`Unknown large upload ${config.uploadId}`);
        largeUploadInfo.delete(config.uploadId);
        let caller = callerId();
        let store = getStore(info.account, info.bucketName, info.storeName);
        await store.finishLargeUpload({ id: config.uploadId, path: info.path, lastModified: info.lastModified, forceSetImmutable: info.forceSetImmutable, noChecks: info.noChecks, internal: info.internal });
        let written = await store.getInfo({ path: info.path });
        logMutation({ op: "setLarge", account: info.account, bucketName: info.bucketName, store: info.storeName, path: info.path, size: written?.size, writeTime: written?.writeTime, callerId: caller });
    }
    /** Best-effort cleanup: an unknown upload has nothing left to cancel. */
    async cancelLargeFile(config: { uploadId: string }): Promise<void> {
        let info = largeUploadInfo.get(config.uploadId);
        if (!info) return;
        largeUploadInfo.delete(config.uploadId);
        await getStore(info.account, info.bucketName, info.storeName).cancelLargeUpload({ id: config.uploadId });
    }

    // IMPORTANT: We can never expose enumeration (listing, prefix search, changes feeds) over this public HTTP endpoint - only exact-key reads. Enumeration would be a massive security risk (public buckets rely on unguessable keys staying unguessable), and could also crash the client by sending them too much data. Listings exist only on the authenticated API (findInfo etc, behind accountAccess).
    async httpEntry(config?: { requireCalls?: string[]; cacheTime?: number }): Promise<Buffer> {
        let caller = SocketFunction.getCaller();
        let request = getCurrentHTTPRequest();
        let pathname = new URL(request?.url || "/", "https://localhost").pathname;
        if (!pathname.startsWith("/file/")) {
            let html = await performLocalCall({
                caller,
                call: { nodeId: caller.nodeId, classGuid: RequireController._classGuid, functionName: "requireHTML", args: [config] },
            }) as Buffer;
            // Without this the access page is served with no content type, and a browser that is told not to sniff simply will not render it
            return setHTTPResultHeaders(html, { "Content-Type": "text/html; charset=utf-8" });
        }
        let parts = pathname.split("/").filter(x => x).map(decodeURIComponent);
        let account = parts[1];
        let bucketName = parts[2];
        let filePath = parts.slice(3).join("/");
        if (!account || !bucketName || !filePath) {
            return setHTTPResultHeaders(Buffer.from(""), { status: "404" });
        }
        assertValidName(account, "account");
        assertValidName(bucketName, "bucket name");
        assertValidPath(filePath);
        let bucketStores = await getBucketStores(account, bucketName);
        if (!bucketStores.length) {
            return setHTTPResultHeaders(Buffer.from(""), { status: "404" });
        }
        // Each store's policy comes from its own config, which it has only read once init ran
        await Promise.all(bucketStores.map(x => x.store.init()));
        let policies = bucketStores.map(x => ({ store: x.store, policy: x.store.storeConfig.current() }));
        if (!policies.some(x => x.policy.public)) {
            throw new Error(`Bucket is not public, so its files cannot be read over plain URLs: ${account}/${bucketName}`);
        }
        // Anonymous URL reads carry no source selection - the file's route picks the store, and a route no store here covers is simply not found (the routing file itself lives outside every store)
        let httpStore: BlobStore | undefined;
        let immutable = false;
        let info: { writeTime: number; size: number } | undefined;
        if (filePath !== ROUTING_FILE) {
            let route = getRoute(filePath);
            let serving = policies.find(x => x.policy.public && routeContains(x.policy.route, route));
            httpStore = serving?.store;
            immutable = !!serving?.policy.immutable;
            info = httpStore && await httpStore.getInfo({ path: filePath }) || undefined;
        } else {
            info = await getRoutingFileResult(account, bucketName);
        }
        if (!info || !info.size) {
            trackAccess({ account, operation: "httpGet", path: `${bucketName}/${filePath}`, size: 0 });
            return setHTTPResultHeaders(Buffer.from(""), { status: "404" });
        }
        let ext = filePath.split(".").pop() || "";
        let headers: { [header: string]: string } = {
            "Content-Type": CONTENT_TYPES[ext.toLowerCase()] || "application/octet-stream",
            "Last-Modified": new Date(info.writeTime).toUTCString(),
            "Accept-Ranges": "bytes",
        };
        // The serving store's own policy - and never for the routing file, which changing is the whole point of
        if (immutable) {
            headers["Cache-Control"] = `max-age=${IMMUTABLE_CACHE_TIME / 1000}`;
        }
        let ifModifiedSince = request?.headers["if-modified-since"];
        if (typeof ifModifiedSince === "string") {
            let since = new Date(ifModifiedSince).getTime();
            if (since && Math.floor(info.writeTime / 1000) * 1000 <= since) {
                return setHTTPResultHeaders(Buffer.from(""), { ...headers, status: "304" });
            }
        }
        let range: { start: number; end: number } | undefined;
        let rangeHeader = request?.headers["range"];
        if (typeof rangeHeader === "string") {
            let match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
            if (match && (match[1] || match[2])) {
                let start: number;
                let endInclusive = info.size - 1;
                if (!match[1]) {
                    start = Math.max(0, info.size - +match[2]);
                } else {
                    start = +match[1];
                    if (match[2]) {
                        endInclusive = Math.min(+match[2], info.size - 1);
                    }
                }
                if (start >= info.size || start > endInclusive) {
                    return setHTTPResultHeaders(Buffer.from(""), { ...headers, "Content-Range": `bytes */${info.size}`, status: "416" });
                }
                range = { start, end: endInclusive + 1 };
            }
        }
        let result: { data: Buffer; writeTime: number; size: number } | undefined;
        if (httpStore) {
            result = await httpStore.get2({ path: filePath, range });
        } else {
            result = await getRoutingFileResult(account, bucketName);
            if (result && range) {
                result = { ...result, data: result.data.subarray(Math.min(range.start, result.data.length), Math.min(range.end, result.data.length)) };
            }
        }
        trackAccess({ account, operation: "httpGet", path: `${bucketName}/${filePath}`, size: result && result.data.length || 0 });
        if (!result) {
            return setHTTPResultHeaders(Buffer.from(""), { status: "404" });
        }
        if (range) {
            return setHTTPResultHeaders(result.data, { ...headers, "Content-Range": `bytes ${range.start}-${range.end - 1}/${info.size}`, status: "206" });
        }
        return setHTTPResultHeaders(result.data, headers);
    }
}

/** The one resolution every data call does: the client's selected sourceConfig NAMES exactly one store (created on first use), and fn runs on it. */
async function withStore<T>(config: { account: string; bucketName: string; sourceConfig: SourceConfig }, fn: (store: BlobStore) => Promise<T>): Promise<T> {
    return await fn(findBucketStore(config.account, config.bucketName, config.sourceConfig));
}

// The caller's node id for the mutation log - read synchronously at method entry (the call context does not survive awaits), and tolerant of there being none (local calls)
function callerId(): string | undefined {
    try {
        return SocketFunction.getCaller()?.nodeId;
    } catch {
        return undefined;
    }
}

const largeUploadInfo = new Map<string, { account: string; bucketName: string; path: string; lastModified?: number; forceSetImmutable?: boolean; noChecks?: boolean; internal?: boolean; storeName: string }>();

const accountAccess: SocketFunctionHook = async (context) => {
    let start = Date.now();
    let config = context.call.args[0] as { account?: string } | undefined;
    await requireAccess(String(config?.account));
    let duration = Date.now() - start;
    if (duration > ACCESS_CHECK_SLOW_TIME) {
        console.log(`Access check for ${context.call.functionName} took ${duration}ms`);
    }
};
const uploadAccess: SocketFunctionHook = async (context) => {
    let config = context.call.args[0] as { uploadId?: string } | undefined;
    let info = largeUploadInfo.get(String(config?.uploadId));
    if (!info) return;
    await requireAccess(info.account);
};
const adminAccess: SocketFunctionHook = async () => {
    requireAdmin();
};

export const RemoteStorageController = SocketFunction.register(
    REMOTE_STORAGE_CLASS_GUID,
    new RemoteStorageControllerBase(),
    () => ({
        ping: {},
        authenticate: {},
        getAccessState: {},
        adminListActiveBuckets: { hooks: [adminAccess] },
        get2: { hooks: [accountAccess] },
        set: { hooks: [accountAccess] },
        del: { hooks: [accountAccess] },
        move: { hooks: [accountAccess] },
        getInfo: { hooks: [accountAccess] },
        findInfo: { hooks: [accountAccess] },
        getChangesAfter2: { hooks: [accountAccess] },
        getArchivesConfig: { hooks: [accountAccess] },
        getIndexInfo: { hooks: [accountAccess] },
        listBuckets: { hooks: [accountAccess] },
        getActiveBucket: { hooks: [accountAccess] },
        activateBucket: { hooks: [accountAccess] },
        clearWriteStats: { hooks: [accountAccess] },
        getAccessStats: { hooks: [accountAccess] },
        getAccessSummaries: { hooks: [accountAccess] },
        getSyncStatus: { hooks: [accountAccess] },
        listLogFiles: { hooks: [accountAccess] },
        getLogFile: { hooks: [accountAccess] },
        startLargeFile: { hooks: [accountAccess] },
        uploadPart: { hooks: [uploadAccess] },
        finishLargeFile: { hooks: [uploadAccess] },
        cancelLargeFile: { hooks: [uploadAccess] },
        httpEntry: {},
    }),
    () => ({
        noClientHooks: true,
        noDefaultHooks: true,
    })
);
