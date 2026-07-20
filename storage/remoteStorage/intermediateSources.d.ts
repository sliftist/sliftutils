import { RemoteConfig, HostedConfig, BackblazeConfig } from "../IArchives";
export declare const INTERMEDIATE_EXPIRE_GRACE: number;
/** Adding or removing intermediates is a real config update, so it takes a real version increment - but a proportional one, so it stays far below whatever the author's next version would be (whether they count 1, 2, 3 or use timestamps), and a million of them still fit under it. */
export declare function nextIntermediateVersion(version: number): number;
type ObjectSource = HostedConfig | BackblazeConfig;
export declare function getIntermediateSources(config: RemoteConfig): ObjectSource[];
export declare function hasIntermediateSources(config: RemoteConfig): boolean;
/** Removes every intermediate entry and rejoins the windows it split, giving back the underlying configuration. Two configs that resolve equal differ only by intermediates. */
export declare function resolveIntermediateSources(config: RemoteConfig): RemoteConfig;
/** Splits every source at splitUrl covering [start, end) so that middle window points at intermediateUrl instead, flagged as intermediate. Idempotent: a config that already contains the exact intermediate comes back unchanged. */
export declare function injectIntermediateSource(config: RemoteConfig, inject: {
    splitUrl: string;
    intermediateUrl: string;
    start: number;
    end: number;
}): RemoteConfig;
/** Intermediates whose window ended more than INTERMEDIATE_EXPIRE_GRACE ago are removed, and the windows they split are rejoined. */
export declare function expireIntermediateSources(config: RemoteConfig, now: number): RemoteConfig;
/** The url of the entry an intermediate was split out of - the neighbour it touches. */
export declare function findSplitUrl(config: RemoteConfig, intermediate: ObjectSource): string | undefined;
export {};
