export type StorageServerConfig = {
    domain: string;
    port: number;
    rootDomain: string;
    folder: string;
};
export declare function setStorageServerConfig(value: StorageServerConfig): void;
export declare function getStorageServerConfig(): StorageServerConfig;
export declare function getStorageServerConfigOptional(): StorageServerConfig | undefined;
export declare function setWritesRejectedReason(reason: string | undefined): void;
export declare function getWritesRejectedReason(): string | undefined;
export declare function assertWritesAllowed(): void;
export declare function getStorageFolder(): string;
export declare function addExtraListenPort(port: number): void;
export declare function removeExtraListenPort(port: number): void;
/** Whether address:port is this server process, including its extra listen ports (a deploy switchover's alternate port is still us). Used to tell which config entries are OUR copy of a bucket - the stores we run - as opposed to peers we synchronize with. Talking to ourselves is not one of the things it prevents: a source that happens to be us is reached over the API like any other. */
export declare function isOwnAddress(address: string, port: number): boolean;
