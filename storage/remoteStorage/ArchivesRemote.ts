module.allowclient = true;

import { SocketFunction } from "socket-function/SocketFunction";
import { timeInMinute } from "socket-function/src/misc";
import { delay } from "socket-function/src/batching";
import { getIdentityCA, loadIdentityCA, sign } from "../../misc/https/certs";
import { IArchives, ArchiveFileInfo } from "../IArchives";
import {
    RemoteStorageController, REMOTE_STORAGE_CLASS_GUID, STORAGE_AUTH_PURPOSE,
    STORAGE_NOT_AUTHENTICATED, STORAGE_ACCESS_DENIED,
} from "./storageController";

// A bucket on our remote storage server (storageServer.ts), used like ArchivesBackblaze. Works in
// Node.js and the browser. Authenticates with this machine's certs.ts identity; if the account
// hasn't trusted this machine yet it requests access, waits, and logs instructions every minute
// (calls block until access is granted).

const ACCESS_RETRY_DELAY = 1000 * 30;
const LARGE_FILE_PART_SIZE = 8 * 1024 * 1024;

export type ArchivesRemoteConfig = {
    address: string;
    port: number;
    account: string;
    bucketName: string;
    // Public buckets are served over plain HTTPS GETs (getURL). Private buckets are API-access only.
    public?: boolean;
    // Fast mode: the server acknowledges writes once they are in memory, flushing to disk after
    // writeDelay (default 5 minutes) and coalescing writes to the same file. A server crash loses
    // writes that haven't flushed yet.
    fast?: boolean;
    writeDelay?: number;
};

export function buildPublicFileURL(config: { address: string; port: number; account: string; bucketName: string; path: string }): string {
    let args = encodeURIComponent(JSON.stringify([config.account, config.bucketName, config.path]));
    return `https://${config.address}:${config.port}/?classGuid=${REMOTE_STORAGE_CLASS_GUID}&functionName=getPublicFile&args=${args}`;
}

// Authenticates a connection to a storage server with this machine's certs.ts identity
export async function authenticateStorage(config: { address: string; port: number; nodeId: string }): Promise<{ machineId: string; ip: string }> {
    // hostServer nodeIds are machine-specific, so connections by domain must target "any server
    // at this address" (which is how browsers always connect)
    SocketFunction.ENABLE_CLIENT_MODE = true;
    let rootDomain = config.address.split(".").slice(-2).join(".");
    await loadIdentityCA(rootDomain);
    let ca = getIdentityCA(rootDomain);
    let time = Date.now();
    let signature = sign({ key: ca.key }, {
        purpose: STORAGE_AUTH_PURPOSE,
        time,
        server: `${config.address}:${config.port}`,
    });
    return await RemoteStorageController.nodes[config.nodeId].authenticate({ certPem: ca.cert.toString(), time, signature });
}

export class ArchivesRemote implements IArchives {
    constructor(private config: ArchivesRemoteConfig) {
        // hostServer nodeIds are machine-specific, so connections by domain must target "any
        // server at this address" (which is how browsers always connect)
        SocketFunction.ENABLE_CLIENT_MODE = true;
    }

    private nodeId = SocketFunction.connect({ address: this.config.address, port: this.config.port });
    private controller = RemoteStorageController.nodes[this.nodeId];
    private setupDone = false;
    private lastDeniedLog = 0;

    public getDebugName() {
        return `remoteStorage/${this.config.address}:${this.config.port}/${this.config.account}/${this.config.bucketName}`;
    }

    private async authenticate(): Promise<void> {
        await authenticateStorage({ address: this.config.address, port: this.config.port, nodeId: this.nodeId });
    }

    // Runs a call, authenticating (and re-authenticating after reconnects) as needed. Unlike
    // call(), does NOT wait for account access.
    private async callAuthed<T>(fnc: () => Promise<T>): Promise<T> {
        try {
            return await fnc();
        } catch (e: any) {
            if (!String(e.stack || e).includes(STORAGE_NOT_AUTHENTICATED)) throw e;
            await this.authenticate();
            return await fnc();
        }
    }

    // Returns undefined if this machine has access to the account. Otherwise puts in an access
    // request and returns our machineId + ip (so the caller can display them alongside the link,
    // for the approver to match the incoming request) and the link to the grant page.
    public async waitingForAccess(): Promise<{ link: string; machineId: string; ip: string } | undefined> {
        let state = await this.callAuthed(() => this.controller.getAccessState(this.config.account));
        if (state.hasAccess) return undefined;
        let requested = await this.callAuthed(() => this.controller.requestAccess(this.config.account));
        return {
            link: `https://${this.config.address}:${this.config.port}/${this.config.account}`,
            machineId: requested.machineId,
            ip: requested.ip,
        };
    }

    private async onAccessDenied(): Promise<void> {
        let requested = await this.callAuthed(() => this.controller.requestAccess(this.config.account));
        if (Date.now() - this.lastDeniedLog > timeInMinute) {
            this.lastDeniedLog = Date.now();
            console.log(`No access to storage account ${JSON.stringify(this.config.account)} on ${this.config.address}:${this.config.port} (our machine ${requested.machineId}, ip ${requested.ip}). Waiting for access to be granted. See https://${this.config.address}:${this.config.port}/${this.config.account} - or grant it with: ${requested.grantAccessCommand}`);
        }
        await delay(ACCESS_RETRY_DELAY);
    }

    private async ensureSetup(): Promise<void> {
        if (this.setupDone) return;
        await this.controller.ensureBucket(this.config.account, this.config.bucketName, {
            public: this.config.public,
            fast: this.config.fast,
            writeDelay: this.config.writeDelay,
        });
        this.setupDone = true;
    }

    // Runs a call, authenticating (and re-authenticating after reconnects) and waiting for account
    // access as needed.
    private async call<T>(fnc: () => Promise<T>): Promise<T> {
        while (true) {
            try {
                await this.ensureSetup();
                return await fnc();
            } catch (e: any) {
                let message = String(e.stack || e);
                if (message.includes(STORAGE_NOT_AUTHENTICATED)) {
                    this.setupDone = false;
                    await this.authenticate();
                    continue;
                }
                if (message.includes(STORAGE_ACCESS_DENIED)) {
                    this.setupDone = false;
                    await this.onAccessDenied();
                    continue;
                }
                throw e;
            }
        }
    }

    public async get(fileName: string, config?: { range?: { start: number; end: number } }): Promise<Buffer | undefined> {
        let result = await this.call(() => this.controller.get(this.config.account, this.config.bucketName, fileName, config?.range));
        return result && Buffer.from(result) || undefined;
    }
    public async set(fileName: string, data: Buffer): Promise<void> {
        await this.call(() => this.controller.set(this.config.account, this.config.bucketName, fileName, data));
    }
    public async del(fileName: string): Promise<void> {
        await this.call(() => this.controller.del(this.config.account, this.config.bucketName, fileName));
    }
    public async getInfo(fileName: string): Promise<{ writeTime: number; size: number } | undefined> {
        return await this.call(() => this.controller.getInfo(this.config.account, this.config.bucketName, fileName));
    }
    public async findInfo(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        return await this.call(() => this.controller.findInfo(this.config.account, this.config.bucketName, prefix, config));
    }
    public async find(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<string[]> {
        return (await this.findInfo(prefix, config)).map(x => x.path);
    }

    public async setLargeFile(config: { path: string; getNextData(): Promise<Buffer | undefined> }): Promise<void> {
        // Ensure we're authenticated with access BEFORE consuming any data (the stream cannot be
        // rewound, so we can't use the retry loop around the actual upload)
        await this.call(() => this.controller.getInfo(this.config.account, this.config.bucketName, config.path));
        let uploadId = await this.controller.startLargeFile(this.config.account, this.config.bucketName, config.path);
        try {
            while (true) {
                let data = await config.getNextData();
                if (!data) break;
                for (let offset = 0; offset < data.length; offset += LARGE_FILE_PART_SIZE) {
                    await this.controller.uploadPart(uploadId, data.subarray(offset, offset + LARGE_FILE_PART_SIZE));
                }
            }
            await this.controller.finishLargeFile(uploadId);
        } catch (e) {
            try {
                await this.controller.cancelLargeFile(uploadId);
            } catch { }
            throw e;
        }
    }

    public async getURL(path: string): Promise<string> {
        if (!this.config.public) {
            throw new Error(`getURL only works on public buckets (private buckets are API-access only). Bucket: ${this.getDebugName()}`);
        }
        return buildPublicFileURL({
            address: this.config.address,
            port: this.config.port,
            account: this.config.account,
            bucketName: this.config.bucketName,
            path,
        });
    }
}
