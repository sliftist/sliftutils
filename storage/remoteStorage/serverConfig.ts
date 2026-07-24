import path from "path";
import { getFileStorageNested2 } from "../FileFolderAPI";
import { TransactionStorage } from "../TransactionStorage";
import { JSONStorage } from "../JSONStorage";
import type { IStorage } from "../IStorage";
import type { AccessRequest, TrustRecord } from "./storageController";
import { getArg } from "./cliArgs";

// The storage server's process-level identity and system state: which server we are (config, extra ports), whether writes are allowed, and the trust/request stores.

export type StorageServerConfig = {
    domain: string;
    port: number;
    rootDomain: string;
    sshTarget: string;
    serverCommand: string;
    folder: string;
};

let config: StorageServerConfig | undefined;
export function setStorageServerConfig(value: StorageServerConfig): void {
    config = value;
}
export function getStorageServerConfig(): StorageServerConfig {
    if (!config) {
        throw new Error(`Storage server is not initialized (this API only works on the storage server)`);
    }
    return config;
}
export function getStorageServerConfigOptional(): StorageServerConfig | undefined {
    return config;
}

let writesRejectedReason: string | undefined;
export function setWritesRejectedReason(reason: string | undefined): void {
    writesRejectedReason = reason;
}
export function getWritesRejectedReason(): string | undefined {
    return writesRejectedReason;
}
export function assertWritesAllowed(): void {
    if (writesRejectedReason) throw new Error(writesRejectedReason);
}

export function getStorageFolder(): string {
    let config = getStorageServerConfigOptional();
    if (config) return config.folder;
    let folder = getArg("folder");
    if (!folder) {
        throw new Error(`Storage server is not initialized and there is no --folder arg, so the storage folder is unknown`);
    }
    return path.resolve(folder);
}

const systemStorages = new Map<string, Promise<IStorage<unknown>>>();
function getSystemStorage<T>(name: string): Promise<IStorage<T>> {
    let storage = systemStorages.get(name);
    if (!storage) {
        storage = (async () => {
            let root = await getFileStorageNested2(getStorageFolder());
            let system = await root.folder.getStorage("system2");
            let transactionName = "storage" + name[0].toUpperCase() + name.slice(1);
            return new JSONStorage<unknown>(new TransactionStorage(await system.folder.getStorage(name), transactionName));
        })();
        systemStorages.set(name, storage);
    }
    return storage as Promise<IStorage<T>>;
}
export function getTrust(): Promise<IStorage<TrustRecord>> {
    return getSystemStorage<TrustRecord>("trust");
}
export function getRequests(): Promise<IStorage<AccessRequest[]>> {
    return getSystemStorage<AccessRequest[]>("requests");
}

export async function setTrustedMachines(config: { account: string; machineIds: string[] }): Promise<void> {
    let trust = await getTrust();
    let prefix = `${config.account}|`;
    let desired = new Set(config.machineIds);
    for (let key of await trust.getKeys()) {
        if (!key.startsWith(prefix)) continue;
        let machineId = key.slice(prefix.length);
        if (desired.has(machineId)) {
            desired.delete(machineId);
            continue;
        }
        console.log(`Removing trust for machine ${machineId} on account ${config.account}`);
        await trust.remove(key);
    }
    for (let machineId of desired) {
        console.log(`Adding trust for machine ${machineId} on account ${config.account}`);
        await trust.set(`${prefix}${machineId}`, { account: config.account, machineId, ip: "", time: Date.now() });
    }
}

const extraListenPorts = new Set<number>();
export function addExtraListenPort(port: number): void {
    extraListenPorts.add(port);
}
export function removeExtraListenPort(port: number): void {
    extraListenPorts.delete(port);
}
/** Whether address:port is this server process. The ONE self test - findSelfIndexes, createApiArchives, and SourceWrapper all consult it, so "is this me" cannot disagree between the routing plan and connection building: a URL that is us on an extra listen port must never become a network client to ourselves, which is how infinite self-request loops form. */
export function isOwnAddress(address: string, port: number): boolean {
    let config = getStorageServerConfigOptional();
    if (!config) return false;
    if (address !== config.domain) return false;
    return port === config.port || extraListenPorts.has(port);
}
