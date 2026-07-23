import { isNode, sort } from "socket-function/src/misc";
import { delay } from "socket-function/src/batching";
import { getSecret } from "../../misc/getSecret";
import { IArchives, HostedConfig, BackblazeConfig, RemoteConfig } from "../IArchives";
import { ROUTING_FILE, getBucketBaseUrl, parseHostedUrl, parseBackblazeUrl, parseRoutingData } from "./remoteConfig";
import { ArchivesRemote } from "./ArchivesRemote";
import { ArchivesUrl } from "./ArchivesUrl";
import { ArchivesBackblaze } from "../backblaze";
import { getLocalArchives, isOwnAddress } from "./storageServerState";

export const RETRY_START_DELAY = 2 * 1000;
export const RETRY_MAX_DELAY = 5 * 60 * 1000;
export const RETRY_GROWTH = 1.5;
const ACCESS_RECHECK_INTERVAL = 60 * 1000;
const SOURCE_FAILURE_COOLDOWN = 30 * 60 * 1000;
// Added to a disconnected source's latency: it still sorts and can still be picked, it just lands after every connected source
const DISCONNECTED_LATENCY_PENALTY = 10 * 1000;
const PING_INTERVAL = 60 * 1000;
const PING_HISTORY = 10;

async function hasBackblazeCreds(): Promise<boolean> {
    if (!isNode()) return false;
    try {
        await getSecret("backblaze.json.applicationKeyId");
        await getSecret("backblaze.json.applicationKey");
        return true;
    } catch {
        return false;
    }
}

// One source of a RemoteConfig, as a usable IArchives. Reads fall back to the public-URL form when we don't have API access; writes always attempt the API (so access granted later is picked up on the next write). When a call fails while the WebSocket is down, noteFailure starts a background reconnect loop with a ramping delay - it never blocks callers, it just keeps trying so the connection eventually comes back. Sources without a WebSocket (backblaze, URL-form, our own local server) report always-connected: they're last-resort sources where throwing is fine.
export class SourceWrapper {
    public api?: IArchives;
    public url?: ArchivesUrl;
    public writeBlocked?: string;
    private remote?: ArchivesRemote;
    private disposed = false;
    private reconnectRunning = false;
    private accessCache?: { hasAccess: boolean; time: number };

    private constructor(
        public config: HostedConfig | BackblazeConfig,
        // false for short-lived probe instances, which must never leave a retry loop behind
        private background: boolean,
    ) { }

    /** Config updates routinely just move a source's valid window (the last window extends forever, then gets reduced when a new entry is appended). The wrapper survives that: only the window changes, keeping the connection, pings, and latency history. */
    public updateValidWindow(validWindow: [number, number]): void {
        let old = this.config.validWindow;
        if (old[0] === validWindow[0] && old[1] === validWindow[1]) return;
        console.log(`Valid window changed for ${this.getDebugName()}: [${old.join(", ")}] -> [${validWindow.join(", ")}]`);
        this.config.validWindow = validWindow;
    }

    public static async create(config: HostedConfig | BackblazeConfig, options?: { background?: boolean; readOnly?: boolean }): Promise<SourceWrapper> {
        let wrapper = new SourceWrapper(config, options?.background !== false);
        // A public bucket serves everything we can read over plain HTTPS GETs, so there is no reason to open an API connection (which costs a WebSocket, and an access grant we likely don't have) just to read it
        if (options?.readOnly && config.public !== false) {
            wrapper.url = new ArchivesUrl(getBucketBaseUrl(config.url));
            wrapper.writeBlocked = `${config.url} is being read in read-only mode (public bucket, and we are not in node), so it is downloaded over plain URLs and cannot be written. Pass directConnect to createArchives to use the API instead.`;
            return wrapper;
        }
        if (config.type === "backblaze") {
            if (await hasBackblazeCreds()) {
                wrapper.api = new ArchivesBackblaze({ bucketName: parseBackblazeUrl(config.url).bucketName, public: config.public, immutable: config.immutable, allowedOrigins: config.allowedOrigins });
            } else if (isNode()) {
                wrapper.writeBlocked = `No backblaze credentials for ${config.url}. Provide backblaze.json.applicationKeyId and backblaze.json.applicationKey via getSecret to enable API access.`;
            } else {
                wrapper.writeBlocked = `Browsers cannot write to backblaze (bucket ${config.url})`;
            }
            if (!wrapper.api && config.public !== false) {
                wrapper.url = new ArchivesUrl(getBucketBaseUrl(config.url));
            }
            return wrapper;
        }
        let parsed = parseHostedUrl(config.url);
        if (isNode() && isOwnAddress(parsed.address, parsed.port)) {
            // A bucket hosted by our own process - use it directly instead of calling ourselves
            wrapper.api = getLocalArchives(parsed.account, parsed.bucketName);
            return wrapper;
        }
        wrapper.remote = new ArchivesRemote({ url: config.url, waitForAccess: false });
        wrapper.api = wrapper.remote;
        if (config.public !== false) {
            wrapper.url = new ArchivesUrl(getBucketBaseUrl(config.url));
        }
        return wrapper;
    }

    public getDebugName(): string {
        // The same URL can appear as multiple sources (different routes / valid windows), so the distinguishing slice is part of the name
        let parts: string[] = [];
        let route = this.config.route;
        if (route) {
            parts.push(`route [${route[0]}, ${route[1]})`);
        }
        let [start, end] = this.config.validWindow;
        if (start !== 0 || end !== Number.MAX_SAFE_INTEGER) {
            let startText = start === 0 && "0" || new Date(start).toISOString();
            let endText = end === Number.MAX_SAFE_INTEGER && "forever" || new Date(end).toISOString();
            parts.push(`validWindow [${startText}, ${endText}]`);
        }
        return `source ${this.config.url}${parts.length && ` (${parts.join(", ")})` || ""}`;
    }

    public isConnected(): boolean {
        if (!this.remote) return true;
        return this.remote.isConnected();
    }

    /** A source whose window has passed is never read from or written to (see the window checks in ArchivesChain), and an intermediate only exists for the minutes of a deploy switchover - on either, being unreachable is expected, not a problem to report. */
    private isConnectionProblemWorthReporting(): boolean {
        if (this.config.intermediate) return false;
        return this.config.validWindow[1] > Date.now();
    }

    private cooldownUntil = 0;
    /** A source that failed while disconnected is skipped by callers for SOURCE_FAILURE_COOLDOWN - but only while some other source can serve the request. When nothing else is usable, callers ignore this and try it anyway, so a total outage still retries every time. */
    public isOnCooldown(): boolean {
        return Date.now() < this.cooldownUntil;
    }

    /** Call after a request failed while isConnected() was false: puts the source on cooldown and starts (if not already running) the background reconnect loop. Never blocks - the failed request still throws. */
    public noteFailure(): void {
        if (this.disposed || this.isConnected()) return;
        let now = Date.now();
        if (now >= this.cooldownUntil && this.isConnectionProblemWorthReporting()) {
            console.error(`Cannot connect to storage ${this.getDebugName()}; skipping it until ${new Date(now + SOURCE_FAILURE_COOLDOWN).toISOString()} (now ${new Date(now).toISOString()}) unless no other source can serve the request`);
        }
        this.cooldownUntil = now + SOURCE_FAILURE_COOLDOWN;
        if (!this.background || this.reconnectRunning) return;
        this.reconnectRunning = true;
        void this.reconnectLoop();
    }

    private async reconnectLoop(): Promise<void> {
        let retryDelay = RETRY_START_DELAY;
        while (true) {
            await delay(retryDelay);
            if (this.disposed) {
                this.reconnectRunning = false;
                return;
            }
            if (this.isConnected()) break;
            try {
                // Any call re-establishes the WebSocket; the result doesn't matter
                await this.remote?.getInfo(ROUTING_FILE);
                break;
            } catch (e) {
                // Even a failing call (e.g. access denied) proves the connection is back
                if (this.isConnected()) break;
                if (this.isConnectionProblemWorthReporting()) {
                    console.error(`Cannot connect to storage ${this.getDebugName()}, retrying in ${Math.round(retryDelay / 1000)}s. ${(e as Error).stack ?? e}`);
                }
            }
            retryDelay = Math.min(RETRY_MAX_DELAY, retryDelay * RETRY_GROWTH);
        }
        this.reconnectRunning = false;
        this.cooldownUntil = 0;
        console.log(`Reconnected to storage ${this.getDebugName()}, clearing its cooldown`);
    }

    // For hosted sources: cached access check, so reads know whether to use the API or the public URL form. Access, once seen, is assumed to stick; no-access is re-checked periodically (the check also registers our access request server-side, which logs the grant link).
    private async checkAccess(): Promise<boolean> {
        let remote = this.remote;
        if (!remote) return !!this.api;
        let cached = this.accessCache;
        if (cached && (cached.hasAccess || Date.now() - cached.time < ACCESS_RECHECK_INTERVAL)) {
            return cached.hasAccess;
        }
        let waiting = await remote.waitingForAccess();
        this.accessCache = { hasAccess: !waiting, time: Date.now() };
        if (waiting) {
            console.warn(`No access to storage account for ${this.config.url} (our machine ${waiting.machineId}, ip ${waiting.ip}). Reading via the public URL form where possible. Grant access at ${waiting.link}`);
        }
        return !waiting;
    }

    public async read<T>(run: (archives: IArchives) => Promise<T>): Promise<T> {
        if (this.api && await this.checkAccess()) {
            return await run(this.api);
        }
        if (this.url) {
            return await run(this.url);
        }
        if (this.api) {
            // No public URL form - let the API call throw its own error (which includes the access instructions for hosted sources)
            return await run(this.api);
        }
        throw new Error(`Source ${this.config.url} has no API access and no public URL form (public: false)`);
    }

    public async readRoutingConfig(): Promise<RemoteConfig | undefined> {
        let data = await this.read(archives => archives.get(ROUTING_FILE));
        return data && parseRoutingData(data) || undefined;
    }

    public async hasWriteAccess(): Promise<boolean> {
        if (this.writeBlocked || !this.api) return false;
        return await this.api.hasWriteAccess();
    }

    private pings: number[] = [];
    private pingTimer: ReturnType<typeof setInterval> | undefined;
    private loggedConnected = false;

    /** Starts measuring this source's latency, which decides which hosts reads and variable-shard writes prefer. Hosted remotes ping over their API connection; URL-only sources (read-only mode, backblaze without credentials) probe over plain HTTPS instead - the client NEEDS their latency too, or it cannot rank the hosts it reads from. Our own local server counts as 0; only sources with neither form stay Infinity. */
    public startPinging(): void {
        if (this.pingTimer || this.disposed) return;
        // A source whose window has passed never receives reads or writes - measuring it is pointless traffic
        if (this.config.validWindow[1] <= Date.now()) return;
        const remote = this.remote;
        const url = this.url;
        let probe: () => Promise<void>;
        if (remote) {
            probe = async () => {
                await remote.ping();
            };
        } else if (url) {
            // A 1-byte ranged read of the routing file transfers essentially nothing, and unlike an explicit OPTIONS request it needs no CORS preflight (backblaze's CORS rules only allow download operations) - so it works from the browser, which is exactly where URL-only mode runs
            probe = async () => {
                await url.getInfo(ROUTING_FILE);
            };
        } else {
            return;
        }
        let measure = async () => {
            let start = Date.now();
            try {
                await probe();
            } catch {
                // A failed ping is also our earliest down-detection
                this.noteFailure();
                return;
            }
            if (!this.loggedConnected) {
                this.loggedConnected = true;
                console.log(`Connected to storage ${this.getDebugName()} (${Date.now() - start}ms)`);
            }
            this.pings.push(Date.now() - start);
            if (this.pings.length > PING_HISTORY) {
                this.pings.shift();
            }
        };
        void measure();
        this.pingTimer = setInterval(() => {
            void measure();
        }, PING_INTERVAL);
        (this.pingTimer as { unref?: () => void }).unref?.();
    }

    /** Seeds the latency estimate before the first ping lands (e.g. from the initial routing fetch), so variable-shard picking has something immediately. Real pings take over from the first measurement on. */
    public seedLatency(ms: number): void {
        if (this.pings.length) return;
        this.pings.push(ms);
    }

    /** Median of the recent pings (API or URL-form, whichever this source measures), plus DISCONNECTED_LATENCY_PENALTY while the source is disconnected - so a down source still sorts and can still be picked, just after every connected one. Sources with no measurements yet sort last (Infinity), except our own in-process server, which is the best possible target (0). */
    public getLatency(): number {
        // Our own in-process server: hosted (type remote), api present, but no remote connection - it IS us
        if (!this.remote && this.config.type === "remote" && this.api) return 0;
        if (!this.pings.length) return Infinity;
        let sorted = [...this.pings];
        sort(sorted, x => x);
        let median = sorted[Math.floor(sorted.length / 2)];
        if (!this.isConnected()) {
            return median + DISCONNECTED_LATENCY_PENALTY;
        }
        return median;
    }

    /** Writes always go through the API, so a permission error throws to the caller on every write (and access granted in the meantime is picked up automatically). */
    public async write<T>(run: (archives: IArchives) => Promise<T>): Promise<T> {
        if (this.writeBlocked) {
            throw new Error(this.writeBlocked);
        }
        let api = this.api;
        if (!api) {
            throw new Error(`Source ${this.config.url} has no API access, so it cannot accept writes`);
        }
        let result = await run(api);
        this.accessCache = { hasAccess: true, time: Date.now() };
        return result;
    }

    public dispose(): void {
        this.disposed = true;
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
        }
    }
}
