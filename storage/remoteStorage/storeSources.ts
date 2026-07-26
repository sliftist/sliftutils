import { IArchives, SourceConfig } from "../IArchives";
import { ArchivesDisk } from "../ArchivesDisk";
import { ArchivesBackblaze } from "../backblaze";
import { ArchivesRemote } from "./ArchivesRemote";
import { parseBackblazeUrl } from "./remoteConfig";
import { ArchivesDelayed, asDelayed, unwrapDelayed } from "./ArchivesDelayed";

// ONE source, talked to directly - the counterpart of createArchives, which resolves a whole routing config into a chain that falls back and re-resolves across many sources. Nothing here picks a source or retries against another one: the caller (a chain, or a store's synchronization) already decided which endpoint it wants, and gets a client bound to exactly that endpoint. Source identity and config updates live here too, because they are the same question - which endpoint is this, and what policy are we applying to it.

/** The client for one configured source: backblaze, or a storage server - including this one. */
export function createApiArchives(source: SourceConfig): IArchives {
    if (source.type === "backblaze") {
        return new ArchivesBackblaze({ bucketName: parseBackblazeUrl(source.url).bucketName, public: source.public, immutable: source.immutable, allowedOrigins: source.allowedOrigins });
    }
    // Including when that server is us: a call to ourselves is a WebSocket to our own port, which authenticates as this machine (so it is always allowed) and costs a round trip on loopback. Not worth a second implementation of every operation to avoid.
    return new ArchivesRemote({ url: source.url, waitForAccess: false, sourceConfig: source });
}

/** The ONE place a store's source is built. Every source a store synchronizes with is one of exactly two things: a configured peer, or the store's own disk folder (no sourceConfig). writeDelay wraps it so its writes are buffered in memory for that long (see ArchivesDelayed) - the whole of "fast writes", per source, decided here. */
export function createStoreSource(config: { sourceConfig?: SourceConfig; folder: string; writeDelay?: number }): IArchives {
    let source: IArchives;
    if (!config.sourceConfig) {
        source = new ArchivesDisk(config.folder);
    } else {
        source = createApiArchives(config.sourceConfig);
    }
    if (config.writeDelay) {
        source = new ArchivesDelayed(source, config.writeDelay);
    }
    return source;
}

/** A source that holds its own SourceConfig (to send with every request, or to read policy flags off). Duck-typed rather than a base class: the three implementations have nothing else in common, and a source that ignores its config simply doesn't have the method. */
type ConfigurableSource = { updateSourceConfig(sourceConfig: SourceConfig): void };

/** Applies a changed config to an ALREADY RUNNING source (same endpoint, see sourceIdentity - only policy moved). Sources that carry their config into every request MUST be updated in place, or they keep sending the old one: the server matches the config it is handed against its own entries, so a source left holding a stale config eventually stops resolving to a store at all. The write delay is policy too, so it moves here as well. */
export function applySourceConfig(source: IArchives, sourceConfig: SourceConfig | undefined, writeDelay?: number): void {
    if (writeDelay !== undefined) {
        asDelayed(source)?.setDelay(writeDelay);
    }
    // The store's own disk has no config to apply - only a delay
    if (!sourceConfig) return;
    // The config belongs to the source itself, not to the delay wrapped around it
    let configurable = unwrapDelayed(source) as Partial<ConfigurableSource>;
    if (typeof configurable.updateSourceConfig !== "function") return;
    configurable.updateSourceConfig(sourceConfig);
}
