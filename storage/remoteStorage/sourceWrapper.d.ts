import { IArchives, HostedConfig, BackblazeConfig } from "../IArchives";
import { ArchivesUrl } from "./ArchivesUrl";
export declare const RETRY_START_DELAY: number;
export declare const RETRY_MAX_DELAY: number;
export declare const RETRY_GROWTH = 1.5;
export declare class SourceWrapper {
    config: HostedConfig | BackblazeConfig;
    private background;
    api?: IArchives;
    url?: ArchivesUrl;
    writeBlocked?: string;
    private remote?;
    private disposed;
    private reconnectRunning;
    private accessCache?;
    private constructor();
    /** Config updates routinely just move a source's valid window (the last window extends
     *  forever, then gets reduced when a new entry is appended). The wrapper survives that: only
     *  the window changes, keeping the connection, pings, and latency history. */
    updateValidWindow(validWindow: [number, number]): void;
    static create(config: HostedConfig | BackblazeConfig, options?: {
        background?: boolean;
    }): Promise<SourceWrapper>;
    getDebugName(): string;
    isConnected(): boolean;
    /** Call after a request failed while isConnected() was false: starts (if not already running)
     *  the background reconnect loop. Never blocks - the failed request still throws. */
    noteFailure(): void;
    private reconnectLoop;
    private checkAccess;
    read<T>(run: (archives: IArchives) => Promise<T>): Promise<T>;
    hasWriteAccess(): Promise<boolean>;
    private pings;
    private pingTimer;
    private loggedConnected;
    private lastTakeoverStamp;
    /** Fired when the source's advertised takeover stamp changes (a deploy takeover started or
     *  ended) - the chain refreshes its config, so connected clients learn within one ping. */
    onServedConfigChanged: (() => void) | undefined;
    /** Starts measuring this source's latency (for variable-shard target preference). Only hosted
     *  remotes are pinged; our own local server counts as 0, everything else as Infinity. */
    startPinging(): void;
    /** Seeds the latency estimate before the first ping lands (e.g. from the initial routing
     *  fetch), so variable-shard picking has something immediately. Real pings take over from the
     *  first measurement on. */
    seedLatency(ms: number): void;
    /** Median of the recent pings. Sources that can't be pinged sort last (Infinity), except our
     *  own in-process server, which is the best possible target (0). */
    getLatency(): number;
    /** Writes always go through the API, so a permission error throws to the caller on every write
     *  (and access granted in the meantime is picked up automatically). */
    write<T>(run: (archives: IArchives) => Promise<T>): Promise<T>;
    dispose(): void;
}
