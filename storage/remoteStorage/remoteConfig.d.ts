/// <reference types="node" />
/// <reference types="node" />
import { RemoteConfig, RemoteConfigBase, SourceConfig, ArchiveFileInfo, ChangesAfterConfig } from "../IArchives";
export declare const ROUTING_FILE = "storage/storagerouting.json";
/** The variable-shard route override embedded in the key ("<sentinel>_<value>", see VARIABLE_SHARD), or undefined when the key has no sentinel or the sentinel has no value yet. */
export declare function parseVariableRoute(key: string): number | undefined;
/** Where a key routes in [0, 1). A materialized variable-shard suffix completely overrides the hash. */
export declare function getRoute(key: string): number;
/** The in-memory getChangesAfter2 emulation, for backends without a native change feed: a full listing filtered down to files written after config.time whose keys route into config.routes. */
export declare function filterChanges(files: ArchiveFileInfo[], config: ChangesAfterConfig): ArchiveFileInfo[];
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
/**
 * Puts a source into the shape the code expects. It does NOT judge it: this runs every time a config
 * is READ, and a config that is already on disk has to keep working - a server that cannot parse its
 * own routing file is a server that cannot serve, and it would stay that way forever. Anything
 * missing or unusable is filled in with the safest equivalent instead, loudly where it matters.
 *
 * Judging happens on the way IN, in assertValidRemoteConfig.
 */
export declare function normalizeSource(source: RemoteConfigBase): SourceConfig;
/** Puts a whole config into the shape the code expects, without judging it - see normalizeSource, and see assertValidRemoteConfig for the judging. */
export declare function normalizeRemoteConfig(config: RemoteConfig | RemoteConfigBase): RemoteConfig;
/**
 * Whether a config may be WRITTEN. Everything here is a rule about the config as a whole, which is
 * exactly why it cannot run on read: a config that is already stored somewhere has to keep being
 * readable, or a server that once accepted a bad one could never start again. Rejecting it at the
 * point it is introduced is what keeps a bad one from ever being stored in the first place.
 */
export declare function assertValidRemoteConfig(config: RemoteConfig): void;
/**
 * The identity of one of a store's SOURCE SLOTS - which is the endpoint it talks to, and not the same
 * question as which store this is (that is CommonConfig.name). A switchover's alternate port is a
 * distinct slot even though it names the same storage, because a slot holds a connection to a port.
 *
 * ONLY the type, the url, and the intermediate's alternate port are part of it: everything else is
 * policy about how we USE the endpoint, and changing policy must never make a store believe it is
 * looking at a NEW source - that would drop every index entry the old one held and rescan it from
 * scratch, so the files it holds go missing from listings until the rescan finishes, for a flag flip.
 *
 * Built by hand rather than by serializing the config, so it cannot change just because the routing
 * file was written with its keys in a different order.
 */
export declare function sourceIdentity(sourceConfig: SourceConfig | undefined): string;
/** What an index entry records as the holder of its bytes (see ArchivesSource.url), so it must name the endpoint FOREVER. An intermediate is a switchover's temporary alternate port onto another source, and that port is gone for good once its window passes - so it is recorded as the source it was split out of, which holds the same bucket and outlives it. */
export declare function sourcePersistentUrl(sourceConfig: SourceConfig | undefined, folder: string): string;
export declare function parseRoutingData(data: Buffer): RemoteConfig;
export declare function serializeRemoteConfig(config: RemoteConfig): Buffer;
