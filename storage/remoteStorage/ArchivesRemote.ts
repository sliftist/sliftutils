import { SocketFunction } from "socket-function/SocketFunction";
import { timeInMinute } from "socket-function/src/misc";
import { delay } from "socket-function/src/batching";
import { getIdentityCA, loadIdentityCA, sign } from "../../misc/https/certs";
import { IArchives, ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus } from "../IArchives";
import { parseHostedUrl, getBucketBaseUrl, buildFileUrl } from "./remoteConfig";
import {
    RemoteStorageController, STORAGE_AUTH_PURPOSE,
    STORAGE_NOT_AUTHENTICATED, STORAGE_ACCESS_DENIED,
} from "./storageController";

// A bucket on our remote storage server (storageServer.ts), used like ArchivesBackblaze. Works in Node.js and the browser. Authenticates with this machine's certs.ts identity; if the account hasn't trusted this machine yet it requests access, and by default waits, logging instructions every minute (calls block until access is granted).

const ACCESS_RETRY_DELAY = 1000 * 30;
const LARGE_FILE_PART_SIZE = 8 * 1024 * 1024;

export type ArchivesRemoteConfig = {
    // The bucket's routing URL, which addresses the server, account, and bucket in one:
    //  https://storage.example.com:4444/file/<account>/<bucketName>/storage/storagerouting.json
    url: string;
    // false: access-denied calls throw immediately (the error includes the access page link) instead of requesting access and blocking until it is granted (the default).
    waitForAccess?: boolean;
};

export function parseStorageUrl(url: string): { address: string; port: number } {
    let u = new URL(url);
    if (u.protocol !== "https:") {
        throw new Error(`Storage URL must use https, got ${JSON.stringify(u.protocol)} in ${JSON.stringify(url)}`);
    }
    return { address: u.hostname, port: +u.port || 443 };
}

// Authenticates a connection to a storage server with this machine's certs.ts identity
export async function authenticateStorage(config: { address: string; port: number; nodeId: string }): Promise<{ machineId: string; ip: string }> {
    // hostServer nodeIds are machine-specific, so connections by domain must target "any server at this address" (which is how browsers always connect)
    SocketFunction.ENABLE_CLIENT_MODE = true;
    let rootDomain = config.address.split(".").slice(-2).join(".");
    await loadIdentityCA(rootDomain);
    let ca = getIdentityCA(rootDomain);
    let data = {
        purpose: STORAGE_AUTH_PURPOSE,
        time: Date.now(),
        server: `${config.address}:${config.port}`,
    };
    let signature = sign({ key: ca.key }, data);
    return await RemoteStorageController.nodes[config.nodeId].authenticate({ certPem: ca.cert.toString(), signature, data });
}

export class ArchivesRemote implements IArchives {
    constructor(private config: ArchivesRemoteConfig) {
        // hostServer nodeIds are machine-specific, so connections by domain must target "any server at this address" (which is how browsers always connect)
        SocketFunction.ENABLE_CLIENT_MODE = true;
    }

    private parsed = parseHostedUrl(this.config.url);
    private account = this.parsed.account;
    private bucketName = this.parsed.bucketName;
    private nodeId = SocketFunction.connect({ address: this.parsed.address, port: this.parsed.port });
    private controller = RemoteStorageController.nodes[this.nodeId];
    private lastDeniedLog = 0;

    public getDebugName() {
        return `remoteStorage ${this.parsed.address}:${this.parsed.port} account ${this.account} bucket ${this.bucketName}`;
    }

    public isConnected(): boolean {
        return SocketFunction.isNodeConnected(this.nodeId);
    }

    public async ping(): Promise<{}> {
        return await this.controller.ping();
    }

    private async authenticate(): Promise<void> {
        await authenticateStorage({ address: this.parsed.address, port: this.parsed.port, nodeId: this.nodeId });
    }

    // Runs a call, authenticating (and re-authenticating after reconnects) as needed. Unlike call(), does NOT wait for account access.
    private async callAuthed<T>(fnc: () => Promise<T>): Promise<T> {
        try {
            return await fnc();
        } catch (e: any) {
            if (!String(e.stack || e).includes(STORAGE_NOT_AUTHENTICATED)) throw e;
            await this.authenticate();
            return await fnc();
        }
    }

    // Returns undefined if this machine has access to the account. Otherwise puts in an access request and returns our machineId + ip (so the caller can display them alongside the link, for the approver to match the incoming request) and the link to the grant page.
    public async waitingForAccess(): Promise<{ link: string; machineId: string; ip: string } | undefined> {
        let state = await this.callAuthed(() => this.controller.getAccessState(this.account));
        if (state.hasAccess) return undefined;
        let requested = await this.callAuthed(() => this.controller.requestAccess(this.account));
        return {
            link: `https://${this.parsed.address}:${this.parsed.port}/${this.account}`,
            machineId: requested.machineId,
            ip: requested.ip,
        };
    }

    public async hasWriteAccess(): Promise<boolean> {
        let state = await this.callAuthed(() => this.controller.getAccessState(this.account));
        return !!state.hasAccess;
    }

    // Registers our access request server-side (so an admin has a requestId to grant) and logs the grant instructions, at most once a minute
    private async registerAccessRequest(): Promise<void> {
        let requested = await this.callAuthed(() => this.controller.requestAccess(this.account));
        if (Date.now() - this.lastDeniedLog > timeInMinute) {
            this.lastDeniedLog = Date.now();
            console.log(`No access to storage account ${JSON.stringify(this.account)} on ${this.parsed.address}:${this.parsed.port} (our machine ${requested.machineId}, ip ${requested.ip}). See https://${this.parsed.address}:${this.parsed.port}/${this.account} - or grant it with: ${requested.grantAccessCommand}`);
        }
    }

    // Runs a call, authenticating (and re-authenticating after reconnects) and waiting for account access as needed. With waitForAccess false, denied calls throw immediately instead - but the access request is still registered (in the background), so the denial is grantable.
    private async call<T>(fnc: () => Promise<T>): Promise<T> {
        while (true) {
            try {
                return await fnc();
            } catch (e: any) {
                let message = String(e.stack || e);
                if (message.includes(STORAGE_NOT_AUTHENTICATED)) {
                    await this.authenticate();
                    continue;
                }
                if (message.includes(STORAGE_ACCESS_DENIED)) {
                    if (this.config.waitForAccess === false) {
                        void this.registerAccessRequest().catch(() => { });
                        throw e;
                    }
                    await this.registerAccessRequest();
                    await delay(ACCESS_RETRY_DELAY);
                    continue;
                }
                throw e;
            }
        }
    }

    public async get(fileName: string, config?: { range?: { start: number; end: number } }): Promise<Buffer | undefined> {
        let result = await this.get2(fileName, config);
        return result && result.data || undefined;
    }
    public async get2(fileName: string, config?: { range?: { start: number; end: number } }): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        let result = await this.call(() => this.controller.get2(this.account, this.bucketName, fileName, config?.range));
        return result && { data: Buffer.from(result.data), writeTime: result.writeTime, size: result.size } || undefined;
    }
    public async set(fileName: string, data: Buffer, config?: { lastModified?: number }): Promise<string> {
        await this.call(() => this.controller.set(this.account, this.bucketName, fileName, data, config?.lastModified));
        return fileName;
    }
    public async del(fileName: string): Promise<void> {
        await this.call(() => this.controller.del(this.account, this.bucketName, fileName));
    }
    public async getInfo(fileName: string): Promise<{ writeTime: number; size: number } | undefined> {
        return await this.call(() => this.controller.getInfo(this.account, this.bucketName, fileName));
    }
    public async findInfo(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        return await this.call(() => this.controller.findInfo(this.account, this.bucketName, prefix, config));
    }
    public async find(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<string[]> {
        return (await this.findInfo(prefix, config)).map(x => x.path);
    }
    public async getChangesAfter(time: number): Promise<ArchiveFileInfo[]> {
        return await this.call(() => this.controller.getChangesAfter(this.account, this.bucketName, time));
    }
    public async getConfig(): Promise<ArchivesConfig> {
        return await this.call(() => this.controller.getArchivesConfig(this.account, this.bucketName));
    }
    public async getSyncStatus(): Promise<ArchivesSyncStatus> {
        return await this.call(() => this.controller.getSyncStatus(this.account, this.bucketName));
    }

    public async setLargeFile(config: { path: string; getNextData(): Promise<Buffer | undefined> }): Promise<void> {
        // Ensure we're authenticated with access BEFORE consuming any data (the stream cannot be rewound, so we can't use the retry loop around the actual upload)
        await this.call(() => this.controller.getInfo(this.account, this.bucketName, config.path));
        let uploadId = await this.controller.startLargeFile(this.account, this.bucketName, config.path);
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
        // Only actually loads for public buckets (the server rejects plain URL reads otherwise)
        return buildFileUrl(getBucketBaseUrl(this.config.url), path);
    }
}
