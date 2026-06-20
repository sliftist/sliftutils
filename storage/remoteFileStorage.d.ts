import type { DirectoryWrapper } from "./FileFolderAPI";
export type RemoteOptions = {
    chunkBytes?: number;
    cacheBytes?: number;
    latencyMs?: number;
    stats?: {
        requestCount: number;
        bytesFetched: number;
    };
};
export declare function getRemoteDirectoryHandle(url: string, password: string, options?: RemoteOptions): DirectoryWrapper;
export type RemoteConnectResult = {
    status: "ok";
} | {
    status: "unauthorized";
} | {
    status: "unreachable";
    error: string;
};
export declare function testRemoteConnection(url: string, password: string, options?: RemoteOptions): Promise<RemoteConnectResult>;
