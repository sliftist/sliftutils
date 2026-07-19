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
    /** Starts measuring this source's latency (for variable-shard target preference). Only hosted
     *  remotes are pinged; our own local server counts as 0, everything else as Infinity. */
    startPinging(): void;
    /** Median of the recent pings. Sources that can't be pinged sort last (Infinity), except our
     *  own in-process server, which is the best possible target (0). */
    getLatency(): number;
    /** Writes always go through the API, so a permission error throws to the caller on every write
     *  (and access granted in the meantime is picked up automatically). */
    write<T>(run: (archives: IArchives) => Promise<T>): Promise<T>;
    dispose(): void;
}
