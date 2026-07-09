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
    public?: boolean;
    fast?: boolean;
    writeDelay?: number;
};
export type AccessState = {
    machineId: string;
    ip: string;
    hasAccess: boolean;
    // The command to run on the storage machine (shown when the caller has no access)
    listAccessCommand: string;
    // Only provided when the caller has access
    machines?: (AccessRequest & { trusted: boolean })[];
};

export type StorageServerState = {
    domain: string;
    port: number;
    rootDomain: string;
    blobStore: BlobStore;
    trust: IStorage<TrustRecord>;
    requests: IStorage<AccessRequest[]>;
    buckets: IStorage<BucketConfig>;
};

let serverState: StorageServerState | undefined;
export function setStorageServerState(state: StorageServerState) {
    serverState = state;
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

function getListAccessCommand(ip: string): string {
    let state = getState();
    return `typenode storage/remoteStorage/storageServer.ts --domain ${state.domain} --port ${state.port} --listAccess ${ip}`;
}

async function getBucketWriteConfig(account: string, bucketName: string): Promise<WriteConfig> {
    let state = getState();
    let config = await state.buckets.get(`${account}/${bucketName}`);
    return { fast: config?.fast, writeDelay: config?.writeDelay };
}
function fileKey(account: string, bucketName: string, path: string): string {
    assertValidName(account, "account");
    assertValidName(bucketName, "bucket name");
    assertValidPath(path);
    return `${account}/${bucketName}/${path}`;
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
    async requestAccess(account: string): Promise<{ machineId: string; ip: string; requestId: string }> {
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
        return { machineId, ip, requestId: existing.requestId };
    }

    async getAccessState(account: string): Promise<AccessState> {
        assertValidName(account, "account");
        let state = getState();
        let machineId = getCallerMachineId();
        let ip = getCallerIP();
        let hasAccess = isAdmin(machineId) || !!await state.trust.get(`${account}|${machineId}`);
        let result: AccessState = { machineId, ip, hasAccess, listAccessCommand: getListAccessCommand(ip) };
        if (!hasAccess) return result;

        let machines = new Map<string, AccessRequest & { trusted: boolean }>();
        for (let requestIp of await state.requests.getKeys()) {
            for (let request of await state.requests.get(requestIp) || []) {
                if (request.account !== account) continue;
                machines.set(request.machineId, { ...request, trusted: false });
            }
        }
        for (let key of await state.trust.getKeys()) {
            if (!key.startsWith(`${account}|`)) continue;
            let record = await state.trust.get(key);
            if (!record) continue;
            let existing = machines.get(record.machineId);
            machines.set(record.machineId, {
                requestId: existing?.requestId || "",
                account,
                machineId: record.machineId,
                ip: record.ip,
                time: record.time,
                trusted: true,
            });
        }
        result.machines = Array.from(machines.values());
        return result;
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
        throw new Error(`No access request found with id ${JSON.stringify(requestId)}. Run --listAccess <ip> to see request ids.`);
    }

    async ensureBucket(account: string, bucketName: string, config: BucketConfig): Promise<void> {
        await requireAccess(account);
        assertValidName(bucketName, "bucket name");
        let state = getState();
        let key = `${account}/${bucketName}`;
        let existing = await state.buckets.get(key);
        if (existing && JSON.stringify(existing) === JSON.stringify(config)) return;
        await state.buckets.set(key, config);
    }

    async get(account: string, bucketName: string, path: string, range?: { start: number; end: number }): Promise<Buffer | undefined> {
        await requireAccess(account);
        return await getState().blobStore.get(fileKey(account, bucketName, path), range);
    }
    async set(account: string, bucketName: string, path: string, data: Buffer): Promise<void> {
        await requireAccess(account);
        let writeConfig = await getBucketWriteConfig(account, bucketName);
        await getState().blobStore.set(fileKey(account, bucketName, path), Buffer.from(data), writeConfig);
    }
    async del(account: string, bucketName: string, path: string): Promise<void> {
        await requireAccess(account);
        let writeConfig = await getBucketWriteConfig(account, bucketName);
        await getState().blobStore.del(fileKey(account, bucketName, path), writeConfig);
    }
    async getInfo(account: string, bucketName: string, path: string): Promise<{ writeTime: number; size: number } | undefined> {
        await requireAccess(account);
        return await getState().blobStore.getInfo(fileKey(account, bucketName, path));
    }
    async findInfo(account: string, bucketName: string, prefix: string, config?: { shallow?: boolean; type?: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        await requireAccess(account);
        assertValidName(bucketName, "bucket name");
        let bucketRoot = `${account}/${bucketName}/`;
        let infos = await getState().blobStore.findInfo(bucketRoot + prefix, config);
        return infos.map(info => ({ ...info, path: info.path.slice(bucketRoot.length) }));
    }

    async startLargeFile(account: string, bucketName: string, path: string): Promise<string> {
        await requireAccess(account);
        // Validates now, so the upload doesn't fail at the end
        fileKey(account, bucketName, path);
        let id = await getState().blobStore.startLargeUpload();
        largeUploadInfo.set(id, { account, bucketName, path });
        return id;
    }
    async uploadPart(uploadId: string, data: Buffer): Promise<void> {
        let info = largeUploadInfo.get(uploadId);
        if (!info) throw new Error(`Unknown large upload ${uploadId}`);
        await requireAccess(info.account);
        await getState().blobStore.appendLargeUpload(uploadId, Buffer.from(data));
    }
    async finishLargeFile(uploadId: string): Promise<void> {
        let info = largeUploadInfo.get(uploadId);
        if (!info) throw new Error(`Unknown large upload ${uploadId}`);
        await requireAccess(info.account);
        largeUploadInfo.delete(uploadId);
        await getState().blobStore.finishLargeUpload(uploadId, fileKey(info.account, info.bucketName, info.path));
    }
    async cancelLargeFile(uploadId: string): Promise<void> {
        let info = largeUploadInfo.get(uploadId);
        if (!info) return;
        await requireAccess(info.account);
        largeUploadInfo.delete(uploadId);
        await getState().blobStore.cancelLargeUpload(uploadId);
    }

    // Serves files from public buckets over plain HTTP GET (see IArchives getURL). No
    // authentication, which is what public means (private buckets are API-access only).
    async getPublicFile(account: string, bucketName: string, path: string): Promise<Buffer> {
        let state = getState();
        let bucket = await state.buckets.get(`${account}/${bucketName}`);
        if (!bucket?.public) {
            throw new Error(`Bucket ${account}/${bucketName} is not public`);
        }
        let data = await state.blobStore.get(fileKey(account, bucketName, path));
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
