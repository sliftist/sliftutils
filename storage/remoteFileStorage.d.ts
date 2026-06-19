/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import https from "https";
import type { FileStorage } from "./FileFolderAPI";
export type RemoteFileStorageOptions = {
    chunkBytes?: number;
    cacheBytes?: number;
    latencyMs?: number;
};
type Connection = {
    url: string;
    password: string;
    latencyMs: number;
    agent: https.Agent | undefined;
    cache: RangeCache;
    stats: {
        requestCount: number;
        bytesFetched: number;
    };
};
declare class RangeCache {
    private chunkBytes;
    private budget;
    private chunks;
    private bytes;
    constructor(chunkBytes: number, budget: number);
    private key;
    private peek;
    private store;
    invalidate(path: string): void;
    getRange(conn: Connection, path: string, start: number, end: number): Promise<Buffer | undefined>;
}
export type RemoteStorageFactory = ((path: string) => Promise<FileStorage>) & {
    stats: Connection["stats"];
};
export declare function getRemoteFileStorage(url: string, password: string, options?: RemoteFileStorageOptions): RemoteStorageFactory;
export {};
