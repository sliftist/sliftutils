import { IArchives, SourceConfig, RemoteConfig } from "../IArchives";
import { ArchivesUrl } from "./ArchivesUrl";
export declare const RETRY_START_DELAY: number;
export declare const RETRY_MAX_DELAY: number;
export declare const RETRY_GROWTH = 1.5;
export declare class SourceWrapper {
    config: SourceConfig;
    private background;
    api?: IArchives;
    url?: ArchivesUrl;
    writeBlocked?: string;
    private remote?;
    private disposed;
    private reconnectRunning;
    private accessCache?;
    private constructor();
    /** Config updates routinely just move a source's valid window (the last window extends forever, then gets reduced when a new entry is appended). The wrapper survives that: only the window changes, keeping the connection, pings, and latency history. */
    updateValidWindow(validWindow: [number, number]): void;
    static create(config: SourceConfig, options?: {
        background?: boolean;
        readOnly?: boolean;
    }): Promise<SourceWrapper>;
    getDebugName(): string;
    isConnected(): boolean;
    /** A source whose window has passed is never read from or written to (see the window checks in ArchivesChain), and an intermediate only exists for the minutes of a deploy switchover - on either, being unreachable is expected, not a problem to report. */
    private isConnectionProblemWorthReporting;
    private cooldownUntil;
    /** A source that failed while disconnected is skipped by callers for SOURCE_FAILURE_COOLDOWN - but only while some other source can serve the request. When nothing else is usable, callers ignore this and try it anyway, so a total outage still retries every time. */
    isOnCooldown(): boolean;
    /** Call after a request failed while isConnected() was false: puts the source on cooldown and starts (if not already running) the background reconnect loop. Never blocks - the failed request still throws. */
    noteFailure(): void;
    private reconnectLoop;
    private checkAccess;
    read<T>(run: (archives: IArchives) => Promise<T>): Promise<T>;
    readRoutingConfig(): Promise<RemoteConfig | undefined>;
    hasWriteAccess(): Promise<boolean>;
    private pings;
    private pingTimer;
    private loggedConnected;
    /** Starts measuring this source's latency, which decides which hosts reads and variable-shard writes prefer. Hosted remotes ping over their API connection; URL-only sources (read-only mode, backblaze without credentials) probe over plain HTTPS instead - the client NEEDS their latency too, or it cannot rank the hosts it reads from. Our own local server counts as 0; only sources with neither form stay Infinity. */
    startPinging(): void;
    /** Seeds the latency estimate before the first ping lands (e.g. from the initial routing fetch), so variable-shard picking has something immediately. Real pings take over from the first measurement on. */
    seedLatency(ms: number): void;
    /** Median of the recent pings (API or URL-form, whichever this source measures), plus DISCONNECTED_LATENCY_PENALTY while the source is disconnected - so a down source still sorts and can still be picked, just after every connected one. Sources with no measurements yet sort last (Infinity), except our own in-process server, which is the best possible target (0). */
    getLatency(): number;
    /** Writes always go through the API, so a permission error throws to the caller on every write (and access granted in the meantime is picked up automatically). */
    write<T>(run: (archives: IArchives) => Promise<T>): Promise<T>;
    dispose(): void;
}
