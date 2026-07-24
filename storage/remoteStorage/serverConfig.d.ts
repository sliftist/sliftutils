import type { IStorage } from "../IStorage";
import type { AccessRequest, TrustRecord } from "./storageController";
export type StorageServerConfig = {
    domain: string;
    port: number;
    rootDomain: string;
    sshTarget: string;
    serverCommand: string;
    folder: string;
};
export declare function setStorageServerConfig(value: StorageServerConfig): void;
export declare function getStorageServerConfig(): StorageServerConfig;
export declare function getStorageServerConfigOptional(): StorageServerConfig | undefined;
export declare function setWritesRejectedReason(reason: string | undefined): void;
export declare function getWritesRejectedReason(): string | undefined;
export declare function assertWritesAllowed(): void;
export declare function getStorageFolder(): string;
export declare function getTrust(): Promise<IStorage<TrustRecord>>;
export declare function getRequests(): Promise<IStorage<AccessRequest[]>>;
export declare function setTrustedMachines(config: {
    account: string;
    machineIds: string[];
}): Promise<void>;
export declare function addExtraListenPort(port: number): void;
export declare function removeExtraListenPort(port: number): void;
/** Whether address:port is this server process. The ONE self test - findSelfIndexes, createApiArchives, and SourceWrapper all consult it, so "is this me" cannot disagree between the routing plan and connection building: a URL that is us on an extra listen port must never become a network client to ourselves, which is how infinite self-request loops form. */
export declare function isOwnAddress(address: string, port: number): boolean;
