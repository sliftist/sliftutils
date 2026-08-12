import { SocketFunction } from "socket-function/SocketFunction";
import { timeInMinute } from "socket-function/src/misc";
import { delay } from "socket-function/src/batching";
import { getIdentityCA, loadIdentityCA, sign } from "../../misc/https/certs";
import { IArchives, ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, ChangesAfterConfig, DelConfig, FindConfig, GetConfig, GetInfoConfig, MoveFileConfig, SourceConfig, SetConfig, SetLargeFileConfig, LARGE_SET_THRESHOLD, bufferChunkStream } from "../IArchives";
import { parseHostedUrl, getBucketBaseUrl, buildFileUrl } from "./remoteConfig";
import {
    RemoteStorageController, STORAGE_AUTH_PURPOSE,
    STORAGE_NOT_AUTHENTICATED, STORAGE_ACCESS_DENIED,
} from "./storageController";

// A bucket on our remote storage server (storageServer.ts), used like ArchivesBackblaze. Works in Node.js and the browser. Authenticates with this machine's certs.ts identity; if the account hasn't trusted this machine yet it requests access, and by default waits, logging instructions every minute (calls block until access is granted).

const ACCESS_RETRY_DELAY = 1000 * 30;
const LARGE_FILE_PART_SIZE = 8 * 1024 * 1024;
// One failed part must not fail a whole large upload: parts are written at explicit offsets (see uploadPart), so a re-sent part is idempotent and can simply be tried again
const LARGE_FILE_PART_RETRIES = 3;
const LARGE_FILE_PART_RETRY_DELAY = 1000 * 5;

export type ArchivesRemoteConfig = {
    // The bucket's routing URL, which addresses the server, account, and bucket in one:
    //  https://storage.example.com:4444/file/<account>/<bucketName>/storage/storagerouting.json
    url: string;
    // false: access-denied calls throw immediately (the error includes the access page link) instead of requesting access and blocking until it is granted (the default).
    waitForAccess?: boolean;
    /** The exact routing-config entry this connection represents, sent with every call so the server picks the matching per-route store (one server hosts one store per route). Instances built from a bare URL fabricate one - it will never match, which only works for calls that don't select a store (internal reads, ROUTING_FILE, getConfig). */
    sourceConfig: SourceConfig;
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

    /** The config travels with every request (the server matches it against its own entries to pick the store), so a config change has to land here - otherwise we keep asking for a source description the server no longer recognizes. Only ever called with a config for the SAME endpoint (see sourceIdentity), so the connection, account, and bucket cannot change under us. */
    public updateSourceConfig(sourceConfig: SourceConfig): void {
        if (sourceConfig.url !== this.config.url) {
            throw new Error(`updateSourceConfig changed endpoints. It must stay on the same endpoint, got ${JSON.stringify(sourceConfig.url)} for ${this.getDebugName()} (${JSON.stringify(this.config.url)})`);
        }
        this.config.sourceConfig = sourceConfig;
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

    // Returns undefined if this machine has access to the account. Otherwise returns our machineId + ip as the server sees them, and the link to the access page - which shows the single command that grants access.
    public async waitingForAccess(): Promise<{ link: string; machineId: string; ip: string } | undefined> {
        let state = await this.callAuthed(() => this.controller.getAccessState({ account: this.account }));
        if (state.hasAccess) return undefined;
        return {
            link: `https://${this.parsed.address}:${this.parsed.port}/${this.account}`,
            machineId: state.machineId,
            ip: state.ip,
        };
    }

    public async hasWriteAccess(): Promise<boolean> {
        let state = await this.callAuthed(() => this.controller.getAccessState({ account: this.account }));
        return !!state.hasAccess;
    }

    // Logs how to get access, at most once a minute. There is nothing to register any more: the server decides from the signed repo, so what it hands back is the command that puts us in it.
    private async registerAccessRequest(): Promise<void> {
        if (Date.now() - this.lastDeniedLog < timeInMinute) return;
        let state = await this.callAuthed(() => this.controller.getAccessState({ account: this.account }));
        this.lastDeniedLog = Date.now();
        console.log(`No access to storage account ${JSON.stringify(this.account)} on ${this.parsed.address}:${this.parsed.port} (our machine ${state.machineId}, ip ${state.ip}). ${state.reason || ""} Grant it with: ${state.addMachineCommand || ""}`);
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

    public async get(fileName: string, config?: GetConfig): Promise<Buffer | undefined> {
        let result = await this.get2(fileName, config);
        return result && result.data || undefined;
    }
    public async get2(fileName: string, config?: GetConfig): Promise<{ data: Buffer; writeTime: number; size: number } | undefined> {
        let result = await this.call(() => this.controller.get2({ account: this.account, bucketName: this.bucketName, path: fileName, sourceConfig: this.config.sourceConfig, range: config?.range, internal: config?.internal, includeTombstones: config?.includeTombstones, includeMarked: config?.includeMarked }));
        return result && { data: Buffer.from(result.data), writeTime: result.writeTime, size: result.size } || undefined;
    }
    public async set(fileName: string, data: Buffer, config?: SetConfig): Promise<string> {
        if (!data.length) {
            throw new Error(`Empty write refused: set was called with an empty buffer for ${JSON.stringify(fileName)} on ${this.getDebugName()}: an empty file IS a deletion in this system and would read back as missing - call del instead`);
        }
        if (data.length > LARGE_SET_THRESHOLD) {
            // One giant message would exceed the wire limit and lag every other client sharing this connection - stream it instead. The config travels with it, so crossing the threshold changes only HOW the bytes move, never what the write means.
            await this.setLargeFile({ path: fileName, ...config, ...bufferChunkStream(data) });
            return fileName;
        }
        await this.call(() => this.controller.set({ account: this.account, bucketName: this.bucketName, path: fileName, data, sourceConfig: this.config.sourceConfig, lastModified: config?.lastModified, forceSetImmutable: config?.forceSetImmutable, internal: config?.internal, undelete: config?.undelete }));
        return fileName;
    }
    public async del(fileName: string, config?: DelConfig): Promise<void> {
        await this.call(() => this.controller.del({ account: this.account, bucketName: this.bucketName, path: fileName, sourceConfig: this.config.sourceConfig, lastModified: config?.lastModified, internal: config?.internal }));
    }
    public async move(config: MoveFileConfig): Promise<void> {
        await this.call(() => this.controller.move({ account: this.account, bucketName: this.bucketName, fromPath: config.fromPath, toPath: config.toPath, sourceConfig: this.config.sourceConfig }));
    }
    public async getInfo(fileName: string, config?: GetInfoConfig): Promise<{ writeTime: number; size: number } | undefined> {
        return await this.call(() => this.controller.getInfo({ account: this.account, bucketName: this.bucketName, path: fileName, sourceConfig: this.config.sourceConfig, includeTombstones: config?.includeTombstones }));
    }
    public async findInfo(prefix: string, config?: FindConfig): Promise<ArchiveFileInfo[]> {
        return await this.call(() => this.controller.findInfo({ account: this.account, bucketName: this.bucketName, prefix, sourceConfig: this.config.sourceConfig, shallow: config?.shallow, type: config?.type, includeMarked: config?.includeMarked, internal: config?.internal }));
    }
    public async find(prefix: string, config?: FindConfig): Promise<string[]> {
        return (await this.findInfo(prefix, config)).map(x => x.path);
    }
    public async getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]> {
        return await this.call(() => this.controller.getChangesAfter2({ account: this.account, bucketName: this.bucketName, sourceConfig: this.config.sourceConfig, time: config.time, routes: config.routes, internal: config.internal }));
    }
    public async getConfig(): Promise<ArchivesConfig> {
        return await this.call(() => this.controller.getArchivesConfig({ account: this.account, bucketName: this.bucketName }));
    }
    public async getSyncStatus(): Promise<ArchivesSyncStatus> {
        return await this.call(() => this.controller.getSyncStatus({ account: this.account, bucketName: this.bucketName }));
    }

    public async setLargeFile(config: SetLargeFileConfig): Promise<void> {
        // Ensure we're authenticated with access BEFORE consuming any data (the stream cannot be rewound, so we can't use the retry loop around the actual upload)
        await this.call(() => this.controller.getInfo({ account: this.account, bucketName: this.bucketName, path: config.path, sourceConfig: this.config.sourceConfig }));
        // The write's semantics (immutability, ordering, internal) are decided by the server at start, before any bytes move - a rejection then costs nothing, while one at finish would waste the whole transfer
        let uploadId = await this.controller.startLargeFile({
            account: this.account,
            bucketName: this.bucketName,
            path: config.path,
            sourceConfig: this.config.sourceConfig,
            lastModified: config.lastModified,
            forceSetImmutable: config.forceSetImmutable,
            noChecks: config.noChecks,
            internal: config.internal,
        });
        try {
            // The upload's absolute position: every part carries its offset, so the server writes it positionally and a retried part lands on the same bytes instead of appending twice
            let uploadOffset = 0;
            while (true) {
                let data = await config.getNextData();
                if (!data) break;
                for (let chunkStart = 0; chunkStart < data.length; chunkStart += LARGE_FILE_PART_SIZE) {
                    let part = data.subarray(chunkStart, chunkStart + LARGE_FILE_PART_SIZE);
                    let partOffset = uploadOffset;
                    uploadOffset += part.length;
                    let attempt = 0;
                    while (true) {
                        try {
                            await this.controller.uploadPart({ uploadId, data: part, offset: partOffset });
                            break;
                        } catch (e) {
                            attempt++;
                            if (attempt > LARGE_FILE_PART_RETRIES) throw e;
                            console.warn(`Part at offset ${partOffset} (${part.length} bytes) of ${JSON.stringify(config.path)} to ${this.getDebugName()} failed (attempt ${attempt} of ${LARGE_FILE_PART_RETRIES + 1}), retrying in ${LARGE_FILE_PART_RETRY_DELAY / 1000}s: ${(e as Error).stack ?? e}`);
                            await delay(LARGE_FILE_PART_RETRY_DELAY);
                        }
                    }
                }
            }
            await this.controller.finishLargeFile({ uploadId });
        } catch (e) {
            try {
                await this.controller.cancelLargeFile({ uploadId });
            } catch { }
            throw e;
        }
    }

    public async getURL(path: string): Promise<string> {
        // Only actually loads for public buckets (the server rejects plain URL reads otherwise)
        return buildFileUrl(getBucketBaseUrl(this.config.url), path);
    }
}
