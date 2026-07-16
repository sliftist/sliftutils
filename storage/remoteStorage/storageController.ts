module.allowclient = true;

import { SocketFunction } from "socket-function/SocketFunction";
import { getNodeIdIP } from "socket-function/src/nodeCache";
import { setHTTPResultHeaders } from "socket-function/src/callHTTPHandler";
import { timeInMinute } from "socket-function/src/misc";
import { getCommonName, getPublicIdentifier, getOwnMachineId, verify, verifyMachineIdForPublicKey } from "../../misc/https/certs";
import { ArchiveFileInfo } from "../IArchives";
import type { BlobStore, WriteConfig } from "./blobStore";
import type { IStorage } from "../IStorage";

// The remote storage server's API. Authentication uses certs.ts machine identities: a client
// proves it owns its machine key by signing a timestamped token (bound to this server, so tokens
// can't be replayed elsewhere), and the server then trusts that connection as that machineId.
// Access to an account is granted to specific machineIds, via a command line command run on the
// storage machine (see storageServer.ts).

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
export type BucketConfig = {
    // This bucket's blob store folder, relative to the server's storage folder. Derived from the
    // account/bucket by ensureBucket for new buckets, and never changed after (so a bucket's data
    // never silently moves). Server-assigned — clients cannot pick folders.
    folder: string;
    public?: boolean;
    fast?: boolean;
    writeDelay?: number;
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

export type StorageServerState = {
    domain: string;
    port: number;
    rootDomain: string;
    // user@externalIp of the storage machine, for generated ssh commands
    sshTarget: string;
    // Absolute command that runs storageServer.ts on the storage machine (admin args appended)
    serverCommand: string;
    // Each bucket has its own blob store (in its own folder, see BucketConfig.folder). The server
    // caches stores per folder, creating them on first use.
    getBlobStore(bucket: BucketConfig): BlobStore;
    trust: IStorage<TrustRecord>;
    requests: IStorage<AccessRequest[]>;
    buckets: IStorage<BucketConfig>;
};

let serverState: StorageServerState | undefined;
export function setStorageServerState(state: StorageServerState) {
    serverState = state;
}

// When set, all write-path operations (creating files, appending large uploads, creating buckets)
// throw this message. Reads, findInfo, and deletes still work — so clients can free space. Managed
// by hostStorageServer's disk-space monitor.
let writesRejectedReason: string | undefined;
export function setWritesRejectedReason(reason: string | undefined) {
    writesRejectedReason = reason;
}
function assertWritesAllowed() {
    if (writesRejectedReason) throw new Error(writesRejectedReason);
}
function getState(): StorageServerState {
    let state = serverState;
    if (!state) throw new Error(`Storage server is not initialized (this API only works on the storage server)`);
    return state;
}

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
    let state = getState();
    return machineId === getOwnMachineId(state.rootDomain);
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
    let state = getState();
    let machineId = getCallerMachineId();
    if (isAdmin(machineId)) return machineId;
    let trusted = await state.trust.get(`${account}|${machineId}`);
    if (!trusted) {
        throw new Error(`${STORAGE_ACCESS_DENIED} Machine ${machineId} has no access to account ${JSON.stringify(account)}. Visit https://${state.domain}:${state.port}/${account} for access instructions.`);
    }
    return machineId;
}

// A single command, runnable from anywhere, that sshes into the storage machine and runs the
// grantAccess CLI there
function getGrantAccessCommand(requestId: string): string {
    let state = getState();
    return `ssh ${state.sshTarget} '${state.serverCommand} --requestId ${requestId}'`;
}

async function getBucketStore(account: string, bucketName: string): Promise<{ store: BlobStore; writeConfig: WriteConfig }> {
    assertValidName(account, "account");
    assertValidName(bucketName, "bucket name");
    let state = getState();
    let config = await state.buckets.get(`${account}/${bucketName}`);
    if (!config) {
        throw new Error(`Bucket ${account}/${bucketName} does not exist. Call ensureBucket first.`);
    }
    return { store: state.getBlobStore(config), writeConfig: { fast: config.fast, writeDelay: config.writeDelay } };
}

class RemoteStorageControllerBase {
    // Proves the caller owns the machine key for the machineId in its certificate. The signature
    // must be fresh and bound to this server, so it cannot be replayed to (or from) other servers.
    async authenticate(token: AuthToken): Promise<{ machineId: string; ip: string }> {
        let state = getState();
        let caller = SocketFunction.getCaller();
        if (Math.abs(Date.now() - token.time) > AUTH_TIME_WINDOW) {
            throw new Error(`Auth token time is too far from the server time (token ${token.time}, server ${Date.now()}, allowed drift ${AUTH_TIME_WINDOW}ms)`);
        }
        verify(token.certPem, token.signature, {
            purpose: STORAGE_AUTH_PURPOSE,
            time: token.time,
            server: `${state.domain}:${state.port}`,
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
        let state = getState();
        let machineId = getCallerMachineId();
        let ip = getCallerIP();
        let requests = await state.requests.get(ip) || [];
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
        await state.requests.set(ip, requests);
        return { machineId, ip, requestId: existing.requestId, grantAccessCommand: getGrantAccessCommand(existing.requestId) };
    }

    async getAccessState(account: string): Promise<AccessState> {
        assertValidName(account, "account");
        let state = getState();
        let machineId = getCallerMachineId();
        let ip = getCallerIP();
        let hasAccess = isAdmin(machineId) || !!await state.trust.get(`${account}|${machineId}`);
        let result: AccessState = { machineId, ip, hasAccess };
        if (!hasAccess) {
            let ownRequest = (await state.requests.get(ip) || []).find(x => x.account === account && x.machineId === machineId);
            if (ownRequest) {
                result.grantAccessCommand = getGrantAccessCommand(ownRequest.requestId);
            }
            return result;
        }

        let trustedMachines: TrustRecord[] = [];
        for (let key of await state.trust.getKeys()) {
            if (!key.startsWith(`${account}|`)) continue;
            let record = await state.trust.get(key);
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
        await requireAccess(account);
        let state = getState();
        return (await state.requests.get(ip) || []).filter(x => x.account === account);
    }

    // Callable by any machine that has access to the request's account (or by the storage-machine
    // admin). Grants the requested access; the caller must supply the specific requestId, which they
    // only get by explicitly looking up requests for a specific IP.
    async grantAccess(requestId: string): Promise<TrustRecord> {
        // Must capture in the synchronous phase — SocketFunction.getCaller() only works before any await.
        let callerMachineId = getCallerMachineId();
        let state = getState();
        for (let ip of await state.requests.getKeys()) {
            for (let request of await state.requests.get(ip) || []) {
                if (request.requestId !== requestId) continue;
                if (!isAdmin(callerMachineId) && !await state.trust.get(`${request.account}|${callerMachineId}`)) {
                    throw new Error(`${STORAGE_ACCESS_DENIED} Machine ${callerMachineId} has no access to account ${JSON.stringify(request.account)}`);
                }
                let record: TrustRecord = {
                    account: request.account,
                    machineId: request.machineId,
                    ip: request.ip,
                    time: Date.now(),
                };
                await state.trust.set(`${request.account}|${request.machineId}`, record);
                return record;
            }
        }
        throw new Error(`No access request found with id ${JSON.stringify(requestId)}. It may have already been granted or expired.`);
    }

    // Admin (must be run from the storage machine itself, which shares the server's machineId).
    // Only returns requests for the given IP, so you cannot accidentally grant a request from an
    // IP you didn't explicitly type in.
    async adminListRequests(ip: string): Promise<AccessRequest[]> {
        requireAdmin();
        let state = getState();
        return await state.requests.get(ip) || [];
    }
    async adminGrantAccess(requestId: string): Promise<TrustRecord> {
        requireAdmin();
        let state = getState();
        for (let ip of await state.requests.getKeys()) {
            for (let request of await state.requests.get(ip) || []) {
                if (request.requestId !== requestId) continue;
                let record: TrustRecord = {
                    account: request.account,
                    machineId: request.machineId,
                    ip: request.ip,
                    time: Date.now(),
                };
                await state.trust.set(`${request.account}|${request.machineId}`, record);
                return record;
            }
        }
        throw new Error(`No access request found with id ${JSON.stringify(requestId)}. It may have already been granted or expired.`);
    }

    async ensureBucket(account: string, bucketName: string, config: Omit<BucketConfig, "folder">): Promise<void> {
        await requireAccess(account);
        assertValidName(bucketName, "bucket name");
        let state = getState();
        let key = `${account}/${bucketName}`;
        let existing = await state.buckets.get(key);
        // The spread comes first so a caller-supplied folder can never override the server-assigned
        // one (folders are server-assigned, see BucketConfig.folder)
        let full: BucketConfig = { ...config, folder: existing?.folder || `buckets/${account}/${bucketName}` };
        if (existing && JSON.stringify(existing) === JSON.stringify(full)) return;
        assertWritesAllowed();
        await state.buckets.set(key, full);
    }

    async get(account: string, bucketName: string, path: string, range?: { start: number; end: number }): Promise<Buffer | undefined> {
        await requireAccess(account);
        assertValidPath(path);
        let { store } = await getBucketStore(account, bucketName);
        return await store.get(path, range);
    }
    async set(account: string, bucketName: string, path: string, data: Buffer): Promise<void> {
        assertWritesAllowed();
        await requireAccess(account);
        assertValidPath(path);
        let { store, writeConfig } = await getBucketStore(account, bucketName);
        await store.set(path, Buffer.from(data), writeConfig);
    }
    async del(account: string, bucketName: string, path: string): Promise<void> {
        await requireAccess(account);
        assertValidPath(path);
        let { store, writeConfig } = await getBucketStore(account, bucketName);
        await store.del(path, writeConfig);
    }
    async getInfo(account: string, bucketName: string, path: string): Promise<{ writeTime: number; size: number } | undefined> {
        await requireAccess(account);
        assertValidPath(path);
        let { store } = await getBucketStore(account, bucketName);
        return await store.getInfo(path);
    }
    async findInfo(account: string, bucketName: string, prefix: string, config?: { shallow?: boolean; type?: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        await requireAccess(account);
        let { store } = await getBucketStore(account, bucketName);
        return await store.findInfo(prefix, config);
    }

    async startLargeFile(account: string, bucketName: string, path: string): Promise<string> {
        assertWritesAllowed();
        await requireAccess(account);
        // Validates now, so the upload doesn't fail at the end
        assertValidPath(path);
        let { store } = await getBucketStore(account, bucketName);
        let id = await store.startLargeUpload();
        largeUploadInfo.set(id, { account, bucketName, path });
        return id;
    }
    async uploadPart(uploadId: string, data: Buffer): Promise<void> {
        assertWritesAllowed();
        let info = largeUploadInfo.get(uploadId);
        if (!info) throw new Error(`Unknown large upload ${uploadId}`);
        await requireAccess(info.account);
        let { store } = await getBucketStore(info.account, info.bucketName);
        await store.appendLargeUpload(uploadId, Buffer.from(data));
    }
    async finishLargeFile(uploadId: string): Promise<void> {
        assertWritesAllowed();
        let info = largeUploadInfo.get(uploadId);
        if (!info) throw new Error(`Unknown large upload ${uploadId}`);
        await requireAccess(info.account);
        largeUploadInfo.delete(uploadId);
        let { store } = await getBucketStore(info.account, info.bucketName);
        await store.finishLargeUpload(uploadId, info.path);
    }
    async cancelLargeFile(uploadId: string): Promise<void> {
        let info = largeUploadInfo.get(uploadId);
        if (!info) return;
        await requireAccess(info.account);
        largeUploadInfo.delete(uploadId);
        let { store } = await getBucketStore(info.account, info.bucketName);
        await store.cancelLargeUpload(uploadId);
    }

    // Serves files from public buckets over plain HTTP GET (see IArchives getURL). No
    // authentication, which is what public means (private buckets are API-access only).
    async getPublicFile(account: string, bucketName: string, path: string): Promise<Buffer> {
        assertValidName(account, "account");
        assertValidName(bucketName, "bucket name");
        let state = getState();
        let bucket = await state.buckets.get(`${account}/${bucketName}`);
        if (!bucket?.public) {
            throw new Error(`Bucket ${account}/${bucketName} is not public`);
        }
        assertValidPath(path);
        let data = await state.getBlobStore(bucket).get(path);
        if (!data) {
            throw new Error(`File not found: ${path} in ${account}/${bucketName}`);
        }
        let ext = path.split(".").pop() || "";
        return setHTTPResultHeaders(data, {
            "Content-Type": CONTENT_TYPES[ext.toLowerCase()] || "application/octet-stream",
        });
    }
}

const largeUploadInfo = new Map<string, { account: string; bucketName: string; path: string }>();

export const RemoteStorageController = SocketFunction.register(
    REMOTE_STORAGE_CLASS_GUID,
    new RemoteStorageControllerBase(),
    () => ({
        authenticate: {},
        requestAccess: {},
        getAccessState: {},
        listRequestsForIP: {},
        grantAccess: {},
        adminListRequests: {},
        adminGrantAccess: {},
        ensureBucket: {},
        get: {},
        set: {},
        del: {},
        getInfo: {},
        findInfo: {},
        startLargeFile: {},
        uploadPart: {},
        finishLargeFile: {},
        cancelLargeFile: {},
        getPublicFile: {},
    })
);
