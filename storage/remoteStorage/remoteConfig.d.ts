/// <reference types="node" />
/// <reference types="node" />
import { RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig } from "../IArchives";
export declare const ROUTING_FILE = "storage/storagerouting.json";
export declare function getConfigVersion(config: RemoteConfig): number;
/** Strips the routing-file suffix, leaving the bucket's public base URL (file paths append to it). */
export declare function getBucketBaseUrl(url: string): string;
export declare function buildFileUrl(baseUrl: string, filePath: string): string;
export declare function parseHostedUrl(url: string): {
    address: string;
    port: number;
    account: string;
    bucketName: string;
};
export declare function parseBackblazeUrl(url: string): {
    bucketName: string;
};
export declare function normalizeSource(source: RemoteConfigBase): HostedConfig | BackblazeConfig;
export declare function normalizeRemoteConfig(config: RemoteConfig | RemoteConfigBase): RemoteConfig;
export declare function parseRoutingData(data: Buffer): RemoteConfig;
export declare function serializeRemoteConfig(config: RemoteConfig): Buffer;
