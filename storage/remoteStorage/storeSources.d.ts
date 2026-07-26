import { IArchives, SourceConfig } from "../IArchives";
/** The client for one configured source: backblaze, or a storage server - including this one. */
export declare function createApiArchives(source: SourceConfig): IArchives;
/** The ONE place a store's source is built. Every source a store synchronizes with is one of exactly two things: a configured peer, or the store's own disk folder (no sourceConfig). writeDelay wraps it so its writes are buffered in memory for that long (see ArchivesDelayed) - the whole of "fast writes", per source, decided here. */
export declare function createStoreSource(config: {
    sourceConfig?: SourceConfig;
    folder: string;
    writeDelay?: number;
}): IArchives;
/** Applies a changed config to an ALREADY RUNNING source (same endpoint, see sourceIdentity - only policy moved). Sources that carry their config into every request MUST be updated in place, or they keep sending the old one: the server matches the config it is handed against its own entries, so a source left holding a stale config eventually stops resolving to a store at all. The write delay is policy too, so it moves here as well. */
export declare function applySourceConfig(source: IArchives, sourceConfig: SourceConfig | undefined, writeDelay?: number): void;
