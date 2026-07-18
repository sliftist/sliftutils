module.allowclient = true;

import { SocketFunction } from "socket-function/SocketFunction";
import { SocketFunctionHook } from "socket-function/SocketFunctionTypes";
import { getNodeIdIP } from "socket-function/src/nodeCache";
import { setHTTPResultHeaders, getCurrentHTTPRequest } from "socket-function/src/callHTTPHandler";
import { performLocalCall } from "socket-function/src/callManager";
import { RequireController } from "socket-function/require/RequireController";
import { timeInMinute } from "socket-function/src/misc";
import { getCommonName, getPublicIdentifier, getOwnMachineId, verify, verifyMachineIdForPublicKey } from "../../misc/https/certs";
import { ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, IMMUTABLE_CACHE_TIME } from "../IArchives";
import { ROUTING_FILE } from "./remoteConfig";
import {
    getStorageServerConfig, getTrust, getRequests, getLoadedBucket, writeBucketFile,
    deleteBucketFile, assertWritesAllowed, assertMutable, LoadedBucket,
} from "./storageServerState";

// The remote storage server's API. Authentication uses certs.ts machine identities: a client
// proves it owns its machine key by signing a timestamped token (bound to this server, so tokens
// can't be replayed elsewhere), and the server then trusts that connection as that machineId.
// Access to an account is granted to specific machineIds, via a command line command run on the
// storage machine (see storageServer.ts).
//
// There is no bucket-creation API: a bucket exists iff its routing config (ROUTING_FILE) exists,
// and writing that file creates or reconfigures the bucket (see storageServerState.ts). Reads of
// nonexistent buckets return undefined / empty, same as reads of nonexistent files.

export const REMOTE_STORAGE_CLASS_GUID = "RemoteStorageController-b7e42a91";
export const STORAGE_AUTH_PURPOSE = "remoteStorage-auth-1";
// Error markers, so clients can identify these failures inside error messages
export const STORAGE_NOT_AUTHENTICATED = "REMOTE_STORAGE_NOT_AUTHENTICATED_cf2f7b1e";
export const STORAGE_ACCESS_DENIED = "REMOTE_STORAGE_ACCESS_DENIED_9d81a4c0";

const AUTH_TIME_WINDOW = timeInMinute * 10;
const MAX_SESSIONS = 100 * 1000;
const MAX_REQUESTS_PER_IP = 50;

export type AuthToken = {
    certPem: string;
    time: number;
    signature: string;
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
    // A single ssh command, runnable from anywhere, that runs the grantAccess CLI on the storage
    // machine to grant the caller's own pending request. Only set when the caller has a pending
    // request (so an already-trusted caller has no need for it).
    grantAccessCommand?: string;
    // Only the machines that ALREADY have access. Pending requests are NEVER listed here — showing
    // them would let a trusted user accidentally approve a random request. Callers see pending
    // requests only by explicitly typing an IP into listRequestsForIP.
    trustedMachines?: TrustRecord[];
};

// callerNodeId -> authenticated machineId. Connections are long-lived websockets, so a session
// lasts until the connection drops (clients re-authenticate on reconnect).
const sessions = new Map<string, string>();

const CONTENT_TYPES: { [ext: string]: string } = {
    html: "text/html", js: "text/javascript", css: "text/css", json: "application/json",
    txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    svg: "image/svg+xml", webp: "image/webp", mp4: "video/mp4", webm: "video/webm",
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
    // Paths are one-to-one with files on disk, so . and .. segments would escape the store folder
    if (path.split("/").some(part => part === "." || part === "..")) {
        throw new Error(`Invalid path ${JSON.stringify(path.slice(0, 200))}, paths cannot contain . or .. segments`);
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

// A single command, runnable from anywhere, that sshes into the storage machine and runs the
// grantAccess CLI there
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
    // Latency measurement (see SourceWrapper's pinging); no auth, it measures the transport
    async ping(): Promise<void> { }

    // Proves the caller owns the machine key for the machineId in its certificate. The signature
    // must be fresh and bound to this server, so it cannot be replayed to (or from) other servers.
    async authenticate(token: AuthToken): Promise<{ machineId: string; ip: string }> {
        let { domain, port } = getStorageServerConfig();
        let caller = SocketFunction.getCaller();
        if (Math.abs(Date.now() - token.time) > AUTH_TIME_WINDOW) {
            throw new Error(`Auth token time is too far from the server time (token ${token.time}, server ${Date.now()}, allowed drift ${AUTH_TIME_WINDOW}ms)`);
        }
        verify(token.certPem, token.signature, {
            purpose: STORAGE_AUTH_PURPOSE,
            time: token.time,
            server: `${domain}:${port}`,
        });
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

    // Records that the calling machine wants access to an account. Requests are kept per requesting
    // IP, so the storage machine's admin can list them with --listAccess <ip> and grant one.
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

    // Callable by any machine that has access to `account`. Returns pending access requests for the
    // account that come from EXACTLY `ip`. Callers must type in an IP explicitly — the server never
    // volunteers a list of requesting IPs, so a trusted user can't accidentally approve a random
    // request from a machine they didn't mean to trust.
    async listRequestsForIP(account: string, ip: string): Promise<AccessRequest[]> {
        let requests = await getRequests();
        return (await requests.get(ip) || []).filter(x => x.account === account);
    }

    // Callable by any machine that has access to the request's account (or by the storage-machine
    // admin). Grants the requested access; the caller must supply the specific requestId, which they
    // only get by explicitly looking up requests for a specific IP.
    async grantAccess(requestId: string): Promise<TrustRecord> {
        // Must capture in the synchronous phase — SocketFunction.getCaller() only works before any await.
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

    // Admin (must be run from the storage machine itself, which shares the server's machineId).
    // Only returns requests for the given IP, so you cannot accidentally grant a request from an
    // IP you didn't explicitly type in.
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
    async set(account: string, bucketName: string, path: string, data: Buffer, lastModified?: number): Promise<void> {
        assertValidName(bucketName, "bucket name");
        assertValidPath(path);
        // Handles bucket creation (writes of ROUTING_FILE), reconfiguration, fast mode, and
        // immutability — see storageServerState.ts
        await writeBucketFile(account, bucketName, path, Buffer.from(data), { lastModified });
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
    // Fast (served from the store's BulkDatabase2 index, not a scan) — see IArchives.getChangesAfter
    async getChangesAfter(account: string, bucketName: string, time: number): Promise<ArchiveFileInfo[]> {
        let bucket = await getBucket(account, bucketName);
        if (!bucket) return [];
        if (!bucket.store.getChangesAfter) {
            throw new Error(`Bucket ${account}/${bucketName} does not support getChangesAfter (rawDisk buckets have no index)`);
        }
        return await bucket.store.getChangesAfter(time);
    }
    async getArchivesConfig(account: string, bucketName: string): Promise<ArchivesConfig> {
        let bucket = await getBucket(account, bucketName);
        // Missing buckets say true, matching what they become once created (the default store type)
        let progress = bucket?.store.getSyncProgress?.();
        return {
            supportsChangesAfter: !bucket || !!bucket.store.getChangesAfter,
            remoteConfig: bucket?.routing,
            index: progress?.index,
            indexSources: progress?.sources,
            readerDiskLimit: progress?.readerDiskLimit,
            syncing: progress?.syncing,
        };
    }
    /** Walks the whole index for exact totals (overall and per holding source) - more expensive
     *  than the maintained counters that getArchivesConfig returns, but immune to counter drift. */
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

    async startLargeFile(account: string, bucketName: string, path: string): Promise<string> {
        assertWritesAllowed();
        // Validates now, so the upload doesn't fail at the end
        assertValidPath(path);
        let bucket = await getBucket(account, bucketName);
        if (!bucket) {
            throw new Error(`Bucket ${account}/${bucketName} does not exist. Write its routing config to ${JSON.stringify(ROUTING_FILE)} to create it.`);
        }
        await assertMutable(bucket, path, Date.now());
        let id = await bucket.store.startLargeUpload();
        largeUploadInfo.set(id, { account, bucketName, path });
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
        await bucket.store.finishLargeUpload(uploadId, info.path);
    }
    async cancelLargeFile(uploadId: string): Promise<void> {
        let info = largeUploadInfo.get(uploadId);
        if (!info) return;
        largeUploadInfo.delete(uploadId);
        let bucket = await getBucket(info.account, info.bucketName);
        if (!bucket) return;
        await bucket.store.cancelLargeUpload(uploadId);
    }

    // The server's single default HTTP route. /file/<account>/<bucketName>/<path> serves files from
    // public buckets over plain GETs (see IArchives.getURL); every other path serves the access
    // page (via RequireController.requireHTML — the path is the account name, see accessPage.tsx).
    async httpEntry(config?: { requireCalls?: string[]; cacheTime?: number }): Promise<Buffer> {
        // Both are keyed by the current call and must be captured synchronously, before any await
        let caller = SocketFunction.getCaller();
        let request = getCurrentHTTPRequest();
        let pathname = new URL(request?.url || "/", "https://localhost").pathname;
        if (!pathname.startsWith("/file/")) {
            return await performLocalCall({
                caller,
                call: { nodeId: caller.nodeId, classGuid: RequireController._classGuid, functionName: "requireHTML", args: [config] },
            }) as Buffer;
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
        // The index answers existence + write time + size without touching any data, so
        // If-Modified-Since and range validation cost nothing
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
            // Last-Modified is served at 1 second resolution, so compare at that resolution
            if (since && Math.floor(info.writeTime / 1000) * 1000 <= since) {
                return setHTTPResultHeaders(Buffer.from(""), { ...headers, status: "304" });
            }
        }
        let range: { start: number; end: number } | undefined;
        let rangeHeader = request?.headers["range"];
        if (typeof rangeHeader === "string") {
            // Single-range form only (bytes=start-end / start- / -suffix); anything else serves the full file
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

const largeUploadInfo = new Map<string, { account: string; bucketName: string; path: string }>();

// Access checks run as hooks on the register shape below, keyed off the call's arguments, so the
// method bodies don't each repeat them
const accountAccess: SocketFunctionHook = async (context) => {
    await requireAccess(String(context.call.args[0]));
};
const uploadAccess: SocketFunctionHook = async (context) => {
    let info = largeUploadInfo.get(String(context.call.args[0]));
    // Unknown upload ids are handled by the methods themselves (throw / no-op)
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
        adminGrantAccess: { hooks: [adminAccess] },
        get: { hooks: [accountAccess] },
        get2: { hooks: [accountAccess] },
        set: { hooks: [accountAccess] },
        del: { hooks: [accountAccess] },
        getInfo: { hooks: [accountAccess] },
        findInfo: { hooks: [accountAccess] },
        getChangesAfter: { hooks: [accountAccess] },
        getArchivesConfig: { hooks: [accountAccess] },
        getIndexInfo: { hooks: [accountAccess] },
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
