import path from "path";
import { getArg } from "./cliArgs";

// The storage server's process-level identity and system state: which server we are (config, extra
// ports), and whether writes are allowed.

export type StorageServerConfig = {
    domain: string;
    port: number;
    rootDomain: string;
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

// Which machines this server trusts is not kept here any more. It lives in the signed
// authorized_keys repo, read through security/machines, so every machine shares one list, with
// revocation and address checking that a per-server store never had. setTrustedMachines, the trust
// store and the access request store all went with it.

const extraListenPorts = new Set<number>();
export function addExtraListenPort(port: number): void {
    extraListenPorts.add(port);
}
export function removeExtraListenPort(port: number): void {
    extraListenPorts.delete(port);
}
/** Whether address:port is this server process, including its extra listen ports (a deploy switchover's alternate port is still us). Used to tell which config entries are OUR copy of a bucket - the stores we run - as opposed to peers we synchronize with. Talking to ourselves is not one of the things it prevents: a source that happens to be us is reached over the API like any other. */
export function isOwnAddress(address: string, port: number): boolean {
    let config = getStorageServerConfigOptional();
    if (!config) return false;
    if (address !== config.domain) return false;
    return port === config.port || extraListenPorts.has(port);
}
