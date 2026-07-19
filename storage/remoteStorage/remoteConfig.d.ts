/// <reference types="node" />
/// <reference types="node" />
import { RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig } from "../IArchives";
export declare const ROUTING_FILE = "storage/storagerouting.json";
/** The variable-shard route override embedded in the key ("<sentinel>_<value>", see VARIABLE_SHARD), or undefined when the key has no sentinel or the sentinel has no value yet. */
export declare function parseVariableRoute(key: string): number | undefined;
/** Where a key routes in [0, 1). A materialized variable-shard suffix completely overrides the hash. */
export declare function getRoute(key: string): number;
export declare function routeContains(route: [number, number] | undefined, value: number): boolean;
export declare function routesOverlap(a: [number, number] | undefined, b: [number, number] | undefined): boolean;
/** The overlap of two route ranges, or undefined when they don't overlap. */
export declare function routeIntersection(a: [number, number] | undefined, b: [number, number] | undefined): [number, number] | undefined;
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
export declare function replaceHostedUrlPort(url: string, port: number): string;
export declare function normalizeSource(source: RemoteConfigBase): HostedConfig | BackblazeConfig;
export declare function normalizeRemoteConfig(config: RemoteConfig | RemoteConfigBase): RemoteConfig;
export declare function parseRoutingData(data: Buffer): RemoteConfig;
export declare function serializeRemoteConfig(config: RemoteConfig): Buffer;
