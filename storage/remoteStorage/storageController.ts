import { SocketFunction } from "socket-function/SocketFunction";
import { SocketFunctionHook } from "socket-function/SocketFunctionTypes";
import { getNodeIdIP } from "socket-function/src/nodeCache";
import { setHTTPResultHeaders, getCurrentHTTPRequest } from "socket-function/src/callHTTPHandler";
import { performLocalCall } from "socket-function/src/callManager";
import { RequireController } from "socket-function/require/RequireController";
import { timeInMinute } from "socket-function/src/misc";
import { getCommonName, getPublicIdentifier, getOwnMachineId, verify, verifyMachineIdForPublicKey } from "../../misc/https/certs";
import { ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, ChangesAfterConfig, IMMUTABLE_CACHE_TIME } from "../IArchives";
import { ROUTING_FILE } from "./remoteConfig";
import {
    getStorageServerConfig, getTrust, getRequests, getLoadedBucket, writeBucketFile,
    deleteBucketFile, assertWritesAllowed, assertMutable, LoadedBucket,
    getBucketConfig, listAccountBuckets, ServerBucketInfo, clearAccountWriteStats,
    getActiveBucket, activateBucket, ActiveBucketInfo, getActiveBucketKeys,
} from "./storageServerState";
import { StorageClientController } from "./storageClientController";

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
    signature: string;
    data: AuthTokenData;
};
export type AccessRequest = {
    requestId: string;
    account: string;
    machineId: string;
    ip: string;
    time: number;
};
export type TrustRecord = {
    account: string;
    machineId: string;
    ip: string;
    time: number;
};
export type AccessState = {
    machineId: string;
    ip: string;
    hasAccess: boolean;
    grantAccessCommand?: string;
    trustedMachines?: TrustRecord[];
};

const sessions = new Map<string, string>();

// We must never serve anything that can be evaluated as code (html, js - and svg, which can embed <script> and runs it when visited as a document). Otherwise a user could host a file and, by visiting it, run it on our domain - giving them access to all of our keys and cookies. PDF stays: browser PDF viewers run any embedded PDF scripting in a sandbox with no access to the serving origin's cookies or DOM.
const CONTENT_TYPES: { [ext: string]: string } = {
    css: "text/css; charset=utf-8", json: "application/json; charset=utf-8",
    txt: "text/plain; charset=utf-8", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", mp4: "video/mp4", webm: "video/webm",
    mp3: "audio/mpeg", wav: "audio/wav", pdf: "application/pdf",
};

function assertValidName(value: string, kind: string) {
    if (!/^[\w-]{1,64}$/.test(value)) {
        throw new Error(`Invalid ${kind} ${JSON.stringify(value)}, expected 1-64 characters of letters/numbers/underscore/dash`);
    }
}
function assertValidPath(path: string) {
    if (Buffer.from(path, "utf8").length > 1000) {
        throw new Error(`Path too long: ${path.length} characters > 1000. Path: ${path.slice(0, 200)}`);
    }
    if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("//") || path.includes("\\") || path.includes("\x00")) {
        throw new Error(`Invalid path ${JSON.stringify(path.slice(0, 200))}, paths cannot be empty, start or end with /, or contain //, backslashes, or null characters`);
    }
    if (path.split("/").some(part => part === "." || part === "..")) {
        throw new Error(`Invalid path ${JSON.stringify(path.slice(0, 200))}, paths cannot contain . or .. segments`);
    }
}

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
async function requireAccess(account: string): Promise<string> {
    assertValidName(account, "account");
    let machineId = getCallerMachineId();
    if (isAdmin(machineId)) return machineId;
    let trust = await getTrust();
    let trusted = await trust.get(`${account}|${machineId}`);
    if (!trusted) {
        let { domain, port } = getStorageServerConfig();
        throw new Error(`${STORAGE_ACCESS_DENIED} Machine ${machineId} has no access to account ${JSON.stringify(account)}. Visit https://${domain}:${port}/${account} for access instructions.`);
    }
    return machineId;
}

function getGrantAccessCommand(requestId: string): string {
    let { sshTarget, serverCommand } = getStorageServerConfig();
    return `ssh ${sshTarget} '${serverCommand} --requestId ${requestId}'`;
}

async function getBucket(account: string, bucketName: string): Promise<LoadedBucket | undefined> {
    assertValidName(account, "account");
    assertValidName(bucketName, "bucket name");
    return await getLoadedBucket(account, bucketName);
}

class RemoteStorageControllerBase {
    async ping(): Promise<{}> {
        trackCaller();
        return {};
    }

    async authenticate(token: AuthToken): Promise<{ machineId: string; ip: string }> {
        let { domain, port } = getStorageServerConfig();
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
        let machineId = getCommonName(token.certPem).split(".")[0];
        if (!verifyMachineIdForPublicKey({ machineId, publicKey: getPublicIdentifier(token.certPem) })) {
            throw new Error(`Certificate common name ${JSON.stringify(getCommonName(token.certPem))} does not match its public key`);
        }
        sessions.set(caller.nodeId, machineId);
        while (sessions.size > MAX_SESSIONS) {
            let oldest = sessions.keys().next().value;
            if (oldest === undefined) break;
            sessions.delete(oldest);
        }
        return { machineId, ip: getCallerIP() };
    }

    async requestAccess(account: string): Promise<{ machineId: string; ip: string; requestId: string; grantAccessCommand: string }> {
        assertValidName(account, "account");
        let machineId = getCallerMachineId();
        let ip = getCallerIP();
        let requestsStorage = await getRequests();
        let requests = await requestsStorage.get(ip) || [];
        let existing = requests.find(x => x.account === account && x.machineId === machineId);
        if (existing) {
            existing.time = Date.now();
        } else {
            existing = {
                requestId: Math.random().toString(36).slice(2, 10),
                account,
                machineId,
                ip,
                time: Date.now(),
            };
            requests.push(existing);
        }
        while (requests.length > MAX_REQUESTS_PER_IP) requests.shift();
        await requestsStorage.set(ip, requests);
        return { machineId, ip, requestId: existing.requestId, grantAccessCommand: getGrantAccessCommand(existing.requestId) };
    }

    async getAccessState(account: string): Promise<AccessState> {
        assertValidName(account, "account");
        let machineId = getCallerMachineId();
        let ip = getCallerIP();
        let trust = await getTrust();
        let hasAccess = isAdmin(machineId) || !!await trust.get(`${account}|${machineId}`);
        let result: AccessState = { machineId, ip, hasAccess };
        if (!hasAccess) {
            let requests = await getRequests();
            let ownRequest = (await requests.get(ip) || []).find(x => x.account === account && x.machineId === machineId);
            if (ownRequest) {
                result.grantAccessCommand = getGrantAccessCommand(ownRequest.requestId);
            }
            return result;
        }

        let trustedMachines: TrustRecord[] = [];
        for (let key of await trust.getKeys()) {
            if (!key.startsWith(`${account}|`)) continue;
            let record = await trust.get(key);
            if (record) trustedMachines.push(record);
        }
        result.trustedMachines = trustedMachines;
        return result;
    }

    async listRequestsForIP(account: string, ip: string): Promise<AccessRequest[]> {
        let requests = await getRequests();
        return (await requests.get(ip) || []).filter(x => x.account === account);
    }

    async grantAccess(requestId: string): Promise<TrustRecord> {
        let callerMachineId = getCallerMachineId();
        let trust = await getTrust();
        let requests = await getRequests();
        for (let ip of await requests.getKeys()) {
            for (let request of await requests.get(ip) || []) {
                if (request.requestId !== requestId) continue;
                if (!isAdmin(callerMachineId) && !await trust.get(`${request.account}|${callerMachineId}`)) {
                    throw new Error(`${STORAGE_ACCESS_DENIED} Machine ${callerMachineId} has no access to account ${JSON.stringify(request.account)}`);
                }
                let record: TrustRecord = {
                    account: request.account,
                    machineId: request.machineId,
                    ip: request.ip,
                    time: Date.now(),
                };
                await trust.set(`${request.account}|${request.machineId}`, record);
                return record;
            }
        }
        throw new Error(`No access request found with id ${JSON.stringify(requestId)}. It may have already been granted or expired.`);
    }

    /** Admin (so only this machine's own processes can call it): the buckets this process has loaded. A deploy successor asks its predecessor for this, so it activates exactly the buckets that are in use instead of every bucket on disk. */
    async adminListActiveBuckets(): Promise<{ account: string; bucketName: string }[]> {
        return getActiveBucketKeys();
    }
    async adminListRequests(ip: string): Promise<AccessRequest[]> {
        let requests = await getRequests();
        return await requests.get(ip) || [];
    }
    async adminGrantAccess(requestId: string): Promise<TrustRecord> {
        let trust = await getTrust();
        let requests = await getRequests();
        for (let ip of await requests.getKeys()) {
            for (let request of await requests.get(ip) || []) {
                if (request.requestId !== requestId) continue;
                let record: TrustRecord = {
                    account: request.account,
                    machineId: request.machineId,
                    ip: request.ip,
                    time: Date.now(),
                };
                await trust.set(`${request.account}|${request.machineId}`, record);
                return record;
            }
        }
        throw new Error(`No access request found with id ${JSON.stringify(requestId)}. It may have already been granted or expired.`);
    }

    async get(account: string, bucketName: string, path: string, range?: { start: number; end: number }): Promise<Buffer | undefined> {
        let result = await this.get2(account, bucketName, path, range);
        return result && result.data || undefined;
    }
    async get2(account: string, bucketName: string, path: string, range?: { start: number; end: number }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        assertValidPath(path);
        let bucket = await getBucket(account, bucketName);
        if (!bucket) return undefined;
        return await bucket.store.get2(path, { range });
    }
    async set(account: string, bucketName: string, path: string, data: Buffer, lastModified?: number, forceSetImmutable?: boolean): Promise<void> {
        assertValidName(bucketName, "bucket name");
        assertValidPath(path);
        await writeBucketFile(account, bucketName, path, Buffer.from(data), { lastModified, forceSetImmutable });
    }
    async del(account: string, bucketName: string, path: string): Promise<void> {
        assertValidName(bucketName, "bucket name");
        assertValidPath(path);
        await deleteBucketFile(account, bucketName, path);
    }
    async getInfo(account: string, bucketName: string, path: string): Promise<{ writeTime: number; size: number } | undefined> {
        assertValidPath(path);
        let bucket = await getBucket(account, bucketName);
        if (!bucket) return undefined;
        return await bucket.store.getInfo(path);
    }
    async findInfo(account: string, bucketName: string, prefix: string, config?: { shallow?: boolean; type?: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        let bucket = await getBucket(account, bucketName);
        if (!bucket) return [];
        return await bucket.store.findInfo(prefix, config);
    }
    async getChangesAfter2(account: string, bucketName: string, config: ChangesAfterConfig): Promise<ArchiveFileInfo[]> {
        let bucket = await getBucket(account, bucketName);
        if (!bucket) return [];
        return await bucket.store.getChangesAfter2(config);
    }
    async getArchivesConfig(account: string, bucketName: string): Promise<ArchivesConfig> {
        let bucket = await getBucket(account, bucketName);
        if (!bucket) return { supportsChangesAfter: true };
        return getBucketConfig(bucket);
    }
    async listBuckets(account: string): Promise<ServerBucketInfo[]> {
        let start = Date.now();
        try {
            return await listAccountBuckets(account);
        } finally {
            // The access hook (and the storage it initializes) runs before this, so a large gap between this and the caller's timing is the hook
            console.log(`listBuckets(${account}) call body took ${Date.now() - start}ms`);
        }
    }
    /** The live, in-memory state of one bucket, or a string saying why it is unavailable. Answered without touching the disk, so it is cheap - but only works while the bucket is loaded here. */
    async getActiveBucket(account: string, bucketName: string): Promise<ActiveBucketInfo | string> {
        assertValidName(bucketName, "bucket name");
        return await getActiveBucket(account, bucketName);
    }
    /** Loads a bucket that exists on this server into memory (starting its synchronization) and returns its live state, or a string saying why it could not be loaded. */
    async activateBucket(account: string, bucketName: string): Promise<ActiveBucketInfo | string> {
        assertValidName(bucketName, "bucket name");
        return await activateBucket(account, bucketName);
    }
    /** Zeroes the write statistics listBuckets reports, for every bucket in the account. */
    async clearWriteStats(account: string): Promise<{ clearedBuckets: number }> {
        assertValidName(account, "account");
        return { clearedBuckets: await clearAccountWriteStats(account) };
    }
    async getIndexInfo(account: string, bucketName: string): Promise<{ fileCount: number; byteCount: number; sources: { debugName: string; fileCount: number; byteCount: number }[] } | undefined> {
        let bucket = await getBucket(account, bucketName);
        if (!bucket || !bucket.store.computeIndexTotals) return undefined;
        return await bucket.store.computeIndexTotals();
    }
    async getSyncStatus(account: string, bucketName: string): Promise<ArchivesSyncStatus> {
        let bucket = await getBucket(account, bucketName);
        if (!bucket) return { allScansComplete: true, indexSize: 0, sources: [] };
        if (!bucket.store.getSyncStatus) {
            throw new Error(`Bucket ${account}/${bucketName} does not support getSyncStatus (rawDisk buckets have no synchronization)`);
        }
        return await bucket.store.getSyncStatus();
    }

    async startLargeFile(account: string, bucketName: string, path: string, lastModified?: number): Promise<string> {
        assertWritesAllowed();
        assertValidPath(path);
        let bucket = await getBucket(account, bucketName);
        if (!bucket) {
            throw new Error(`Bucket ${account}/${bucketName} does not exist. Write its routing config to ${JSON.stringify(ROUTING_FILE)} to create it.`);
        }
        await assertMutable(bucket, path, lastModified || Date.now());
        let id = await bucket.store.startLargeUpload();
        largeUploadInfo.set(id, { account, bucketName, path, lastModified });
        return id;
    }
    async uploadPart(uploadId: string, data: Buffer): Promise<void> {
        assertWritesAllowed();
        let info = largeUploadInfo.get(uploadId);
        if (!info) throw new Error(`Unknown large upload ${uploadId}`);
        let bucket = await getBucket(info.account, info.bucketName);
        if (!bucket) throw new Error(`Bucket ${info.account}/${info.bucketName} no longer exists`);
        await bucket.store.appendLargeUpload(uploadId, Buffer.from(data));
    }
    async finishLargeFile(uploadId: string): Promise<void> {
        assertWritesAllowed();
        let info = largeUploadInfo.get(uploadId);
        if (!info) throw new Error(`Unknown large upload ${uploadId}`);
        largeUploadInfo.delete(uploadId);
        let bucket = await getBucket(info.account, info.bucketName);
        if (!bucket) throw new Error(`Bucket ${info.account}/${info.bucketName} no longer exists`);
        await bucket.store.finishLargeUpload(uploadId, info.path, info.lastModified);
    }
    async cancelLargeFile(uploadId: string): Promise<void> {
        let info = largeUploadInfo.get(uploadId);
        if (!info) return;
        largeUploadInfo.delete(uploadId);
        let bucket = await getBucket(info.account, info.bucketName);
        if (!bucket) return;
        await bucket.store.cancelLargeUpload(uploadId);
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
        let bucket = await getLoadedBucket(account, bucketName);
        if (!bucket) {
            return setHTTPResultHeaders(Buffer.from(""), { status: "404" });
        }
        if (!bucket.self?.public) {
            throw new Error(`Bucket ${account}/${bucketName} is not public, so its files cannot be read over plain URLs`);
        }
        let info = await bucket.store.getInfo(filePath);
        if (!info || !info.size) {
            return setHTTPResultHeaders(Buffer.from(""), { status: "404" });
        }
        let ext = filePath.split(".").pop() || "";
        let headers: { [header: string]: string } = {
            "Content-Type": CONTENT_TYPES[ext.toLowerCase()] || "application/octet-stream",
            "Last-Modified": new Date(info.writeTime).toUTCString(),
            "Accept-Ranges": "bytes",
        };
        if (bucket.self?.immutable) {
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
        let result = await bucket.store.get2(filePath, { range });
        if (!result) {
            return setHTTPResultHeaders(Buffer.from(""), { status: "404" });
        }
        if (range) {
            return setHTTPResultHeaders(result.data, { ...headers, "Content-Range": `bytes ${range.start}-${range.end - 1}/${info.size}`, status: "206" });
        }
        return setHTTPResultHeaders(result.data, headers);
    }
}

const largeUploadInfo = new Map<string, { account: string; bucketName: string; path: string; lastModified?: number }>();

const accountAccess: SocketFunctionHook = async (context) => {
    let start = Date.now();
    await requireAccess(String(context.call.args[0]));
    let duration = Date.now() - start;
    if (duration > ACCESS_CHECK_SLOW_TIME) {
        console.log(`Access check for ${context.call.functionName} took ${duration}ms`);
    }
};
const uploadAccess: SocketFunctionHook = async (context) => {
    let info = largeUploadInfo.get(String(context.call.args[0]));
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
        requestAccess: {},
        getAccessState: {},
        listRequestsForIP: { hooks: [accountAccess] },
        grantAccess: {},
        adminListRequests: { hooks: [adminAccess] },
        adminListActiveBuckets: { hooks: [adminAccess] },
        adminGrantAccess: { hooks: [adminAccess] },
        get: { hooks: [accountAccess] },
        get2: { hooks: [accountAccess] },
        set: { hooks: [accountAccess] },
        del: { hooks: [accountAccess] },
        getInfo: { hooks: [accountAccess] },
        findInfo: { hooks: [accountAccess] },
        getChangesAfter2: { hooks: [accountAccess] },
        getArchivesConfig: { hooks: [accountAccess] },
        getIndexInfo: { hooks: [accountAccess] },
        listBuckets: { hooks: [accountAccess] },
        getActiveBucket: { hooks: [accountAccess] },
        activateBucket: { hooks: [accountAccess] },
        clearWriteStats: { hooks: [accountAccess] },
        getSyncStatus: { hooks: [accountAccess] },
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
