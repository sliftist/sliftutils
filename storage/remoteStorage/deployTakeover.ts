import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { RemoteConfig, RemoteConfigBase, HostedConfig } from "../IArchives";
import { parseHostedUrl, replaceHostedUrlPort } from "./remoteConfig";

// Deploy takeover: the deploy manager (querysub's parametersTimeline) writes <n>-parameters.json
// files into our instance folder describing when each version runs and when it is shut down. Old
// and new version overlap for the overlap time (O = oldEnd - newStart). We turn that overlap into
// an atomic write handoff by REINTERPRETING every routing source that points at us: its valid
// window is split so that the middle of the overlap ([S + 0.5*O, S + 1.5*O]) points at the new
// process's temporary alternate port. The existing valid-window machinery then does everything -
// the old process starts rejecting fresh writes at the first boundary, clients re-resolve, and the
// new process (which recognizes the alternate port as itself) takes over. The remap is an
// INTERPRETATION OVERLAY, applied where routing configs are used (see applyDeployRemap callers) -
// it is never written to disk, never synchronized, and never part of any stored configuration.
//
// Everything here is recomputed idempotently from its inputs (timeline files, the port registry,
// our ancestor pids, the clock) - files can appear or change at any moment, and we can start at
// any point during a switchover.

const PARAMETERS_TIMELINE_FILE_REGEX = /^(\d+)-parameters\.json$/;
const TIMELINE_POLL_INTERVAL = 60 * 1000;
// Processes listening on an alternate port register it here (sibling of the storage folder), keyed
// by their actual pid; content includes their ancestor pids so the timeline entry pid (a shell
// ancestor of the process) can be matched to a registry entry
const PORT_REGISTRY_FOLDER_NAME = "storagePortRegistry";
// Main-port acquisition attempts run this often, tightening near the predecessor's scheduled death
const ACQUIRE_SLOW_DELAY = 30 * 1000;
const ACQUIRE_FAST_DELAY = 5 * 1000;
const ACQUIRE_FAST_WINDOW = 60 * 1000;
// Disk rescans fire this far before and after the write handoff, catching files the other process
// wrote (the BulkDatabase2 index is atomic but its entries land at write time, not file time)
const SWITCH_SCAN_LEAD = 10 * 1000;
// The dying process must have flushed everything before the handoff: fast-write delays never
// extend past S + overlap * this fraction, and after that point fast writes flush immediately
const FLUSH_DEADLINE_FRACTION = 0.25;
const BOUNDARY_A_FRACTION = 0.5;
const BOUNDARY_B_FRACTION = 1.5;
const REMAP_EXPIRE_FRACTION = 2;

type TimelineEntry = {
    pid?: number;
    // releaseTime + overlapTime define everything: the newer entry's releaseTime is when it
    // starts, and releaseTime + overlapTime is when the older one is killed (freeing the port).
    // The files also carry an aliveWindow, which is deliberately ignored.
    parameters: { releaseTime?: number; overlapTime?: number };
};

type TakeoverComputed = {
    // We are scheduled to die with a successor overlapping us (known from the files alone, before
    // the successor's port is discovered - the flush deadline applies immediately)
    dying?: { successorStart: number; overlap: number };
    // The window reinterpretation, once the middle window's port is known (the successor's
    // registered alternate port - or our own, when we ARE the successor)
    remap?: { boundaryA: number; boundaryB: number; expire: number; altPort: number };
    // When our predecessor dies and frees the main port (for acquisition pacing)
    predecessorEnd?: number;
};

export type TakeoverEvent = "remapChanged" | "diskScan";

let initialized: { domain: string; mainPort: number; storageFolder: string } | undefined;
let ancestorPids = new Set<number>();
let timelineFolder: string | undefined;
let ourAltPort: number | undefined;
let current: TakeoverComputed = {};
let currentKey = JSON.stringify(current);
let eventListeners: ((event: TakeoverEvent) => void)[] = [];
let eventTimers: ReturnType<typeof setTimeout>[] = [];
let loggedNoMatch = false;
let loggedIdentity = false;

function execText(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

// The timeline entry pid is the screen shell that spawned us - an ancestor - so we walk our whole
// ancestor chain to find which entry is us
async function getAncestorPids(): Promise<Set<number>> {
    let pids = new Set<number>([process.pid]);
    let currentPid = process.pid;
    while (true) {
        let ppid: number;
        if (currentPid === process.pid && process.ppid) {
            ppid = process.ppid;
        } else {
            try {
                ppid = parseInt((await execText(`ps -o ppid= -p ${currentPid}`)).trim());
            } catch {
                break;
            }
        }
        if (!ppid || Number.isNaN(ppid) || ppid <= 1 || pids.has(ppid)) break;
        pids.add(ppid);
        currentPid = ppid;
    }
    return pids;
}

// The instance folder is ALWAYS the parent of our cwd (services run in <instance>/git/) - never
// search for it, a walk could latch onto the wrong folder
function getTimelineFolder(): string {
    return path.dirname(process.cwd()).replaceAll("\\", "/") + "/";
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as { code?: string }).code === "EPERM";
    }
}

function getRegistryFolder(): string {
    if (!initialized) {
        throw new Error(`Deploy takeover is not initialized`);
    }
    return path.join(path.dirname(path.resolve(initialized.storageFolder)), PORT_REGISTRY_FOLDER_NAME);
}

type RegistryEntry = { pid: number; port: number; ancestorPids: number[] };

async function readPortRegistry(): Promise<RegistryEntry[]> {
    let folder = getRegistryFolder();
    let files: string[] = [];
    try {
        files = await fs.promises.readdir(folder);
    } catch {
        return [];
    }
    let entries: RegistryEntry[] = [];
    for (let file of files) {
        let match = /^(\d+)\.json$/.exec(file);
        if (!match) continue;
        let pid = parseInt(match[1]);
        if (!pidAlive(pid)) {
            try {
                await fs.promises.unlink(path.join(folder, file));
            } catch { }
            continue;
        }
        try {
            let entry = JSON.parse(await fs.promises.readFile(path.join(folder, file), "utf8")) as RegistryEntry;
            entries.push({ ...entry, pid });
        } catch { }
    }
    return entries;
}

async function readTimelineEntries(): Promise<TimelineEntry[]> {
    if (!timelineFolder) return [];
    let entries: TimelineEntry[] = [];
    for (let file of await fs.promises.readdir(timelineFolder)) {
        if (!PARAMETERS_TIMELINE_FILE_REGEX.test(file)) continue;
        try {
            entries.push(JSON.parse(await fs.promises.readFile(timelineFolder + file, "utf8")) as TimelineEntry);
        } catch (e) {
            console.warn(`Could not read deploy timeline file ${timelineFolder + file}: ${(e as Error).stack ?? e}`);
        }
    }
    return entries;
}

function makeRemap(successorStart: number, overlap: number, altPort: number): TakeoverComputed["remap"] {
    return {
        boundaryA: successorStart + overlap * BOUNDARY_A_FRACTION,
        boundaryB: successorStart + overlap * BOUNDARY_B_FRACTION,
        expire: successorStart + overlap * REMAP_EXPIRE_FRACTION,
        altPort,
    };
}

function emit(event: TakeoverEvent): void {
    for (let listener of eventListeners) {
        try {
            listener(event);
        } catch (e) {
            console.error(`Deploy takeover listener failed: ${(e as Error).stack ?? e}`);
        }
    }
}

function scheduleEvents(): void {
    for (let timer of eventTimers) {
        clearTimeout(timer);
    }
    eventTimers = [];
    let now = Date.now();
    let schedule = (time: number, fnc: () => void) => {
        if (time <= now) return;
        let timer = setTimeout(fnc, time - now);
        (timer as { unref?: () => void }).unref?.();
        eventTimers.push(timer);
    };
    let remap = current.remap;
    if (remap) {
        let altPort = remap.altPort;
        schedule(remap.boundaryA - SWITCH_SCAN_LEAD, () => emit("diskScan"));
        schedule(remap.boundaryA, () => console.log(`Deploy switchover write handoff boundary passed: fresh writes now belong to the alternate-port side (port ${altPort})`));
        schedule(remap.boundaryA + SWITCH_SCAN_LEAD, () => emit("diskScan"));
        schedule(remap.boundaryB, () => console.log(`Deploy switchover second boundary passed: fresh writes return to the main port`));
        schedule(remap.expire, () => void recompute().catch((e: Error) => console.error(`Deploy takeover recompute failed: ${e.stack ?? e}`)));
    }
}

async function recompute(): Promise<void> {
    if (!initialized || !timelineFolder) return;
    let now = Date.now();
    let entries = await readTimelineEntries();
    let registry = await readPortRegistry();
    let us: TimelineEntry | undefined;
    for (let entry of entries) {
        if (entry.pid && ancestorPids.has(entry.pid)) {
            us = entry;
        }
    }
    // Matching failures must be loud, or takeover detection fails silently forever
    if (!us && entries.length && !loggedNoMatch) {
        loggedNoMatch = true;
        console.warn(`No deploy timeline entry matches our pid chain (${[...ancestorPids].join(", ")}) - takeover detection cannot work. Entries: ${entries.map(x => `pid=${x.pid ?? "none"} releaseTime=${x.parameters.releaseTime}`).join(" | ")}`);
    }
    if (us && !loggedIdentity) {
        loggedIdentity = true;
        console.log(`Deploy timeline entry matched: we are pid=${us.pid}, releaseTime=${us.parameters.releaseTime !== undefined && iso(us.parameters.releaseTime) || "unknown"}, ${entries.length} entries total`);
    }
    let computed: TakeoverComputed = {};
    let usRelease = us?.parameters.releaseTime;
    if (us && usRelease !== undefined) {
        // The newer entry's releaseTime is when it starts; releaseTime + overlapTime is when the
        // older one is killed. That's the whole timeline.
        let next: { entry: TimelineEntry; release: number } | undefined;
        let prev: { entry: TimelineEntry; release: number } | undefined;
        for (let entry of entries) {
            if (entry === us) continue;
            let release = entry.parameters.releaseTime;
            if (release === undefined) continue;
            if (release > usRelease && (!next || release < next.release)) {
                next = { entry, release };
            }
            if (release < usRelease && (!prev || release > prev.release)) {
                prev = { entry, release };
            }
        }
        if (next) {
            let successorStart = next.release;
            let overlap = next.entry.parameters.overlapTime || us.parameters.overlapTime || 0;
            // Even a ZERO-overlap deploy needs the dying behaviors - draining fast-write flushes
            // by the release and writing through after it, or acknowledged data dies with us.
            // Only the remap (the alternate-port middle window) needs an actual overlap.
            computed.dying = { successorStart, overlap };
            if (overlap > 0 && now < successorStart + overlap * REMAP_EXPIRE_FRACTION) {
                const successorPid = next.entry.pid;
                if (successorPid) {
                    let successorEntry = registry.find(x => x.ancestorPids.includes(successorPid));
                    if (successorEntry) {
                        computed.remap = makeRemap(successorStart, overlap, successorEntry.port);
                    }
                }
            }
        }
        if (prev) {
            let overlap = us.parameters.overlapTime || prev.entry.parameters.overlapTime || 0;
            // The predecessor holds the main port until OUR release + the overlap
            computed.predecessorEnd = usRelease + overlap;
            if (overlap > 0 && ourAltPort && now < usRelease + overlap * REMAP_EXPIRE_FRACTION && !computed.remap) {
                computed.remap = makeRemap(usRelease, overlap, ourAltPort);
            }
        }
    }
    let key = JSON.stringify(computed);
    if (key === currentKey) return;
    logTransitions(current, computed);
    current = computed;
    currentKey = key;
    scheduleEvents();
    emit("remapChanged");
}

function iso(time: number): string {
    return new Date(time).toISOString();
}

// The switchover lifecycle is rare and important, so every stage gets a clear line
function logTransitions(prev: TakeoverComputed, next: TakeoverComputed): void {
    if (!prev.dying && next.dying) {
        let { successorStart, overlap } = next.dying;
        console.log(`Deploy switchover scheduled: our successor starts at ${iso(successorStart)}; fast-write flushes drain by ${iso(successorStart + overlap * FLUSH_DEADLINE_FRACTION)}, fresh writes hand off at ${iso(successorStart + overlap * BOUNDARY_A_FRACTION)}, and we are killed at ${iso(successorStart + overlap)}`);
    }
    if (!prev.predecessorEnd && next.predecessorEnd) {
        console.log(`We are a deploy successor: our predecessor holds the main port until ${iso(next.predecessorEnd)}`);
    }
    if (!prev.remap && next.remap) {
        console.log(`Deploy switchover remap active: sources pointing at us are split so [${iso(next.remap.boundaryA)} .. ${iso(next.remap.boundaryB)}] routes to alternate port ${next.remap.altPort} (remap expires at ${iso(next.remap.expire)})`);
    }
    if (prev.remap && !next.remap) {
        console.log(`Deploy switchover remap ended; running on the plain stored routing config`);
    }
}

/** Starts the takeover machinery. Port fallback (alternate port + registry + acquisition polling)
 *  works regardless; without a deploy timeline folder the switchover-specific parts (the remap,
 *  the flush deadline, the tighter acquisition pacing) simply stay inert. */
export async function initDeployTakeover(config: { domain: string; mainPort: number; storageFolder: string }): Promise<void> {
    initialized = config;
    ancestorPids = await getAncestorPids();
    timelineFolder = getTimelineFolder();
    let entries = await readTimelineEntries();
    if (!entries.length) {
        console.log(`No deploy timeline entries in ${timelineFolder}; deploy takeover inactive until they appear (port fallback still works)`);
    } else {
        console.log(`Deploy timeline found at ${timelineFolder} (${entries.length} entries); our pid chain: ${[...ancestorPids].join(" -> ")}`);
    }
    await recompute();
    let poll = setInterval(() => {
        void recompute().catch((e: Error) => console.error(`Deploy takeover recompute failed: ${e.stack ?? e}`));
    }, TIMELINE_POLL_INTERVAL);
    (poll as { unref?: () => void }).unref?.();
}

/** Called when we had to listen on an alternate port (the main port was still held by our
 *  predecessor): registers it so the predecessor can route the middle overlap window to us. */
export async function registerAltPort(port: number): Promise<void> {
    ourAltPort = port;
    let folder = getRegistryFolder();
    await fs.promises.mkdir(folder, { recursive: true });
    let entry: RegistryEntry = { pid: process.pid, port, ancestorPids: [...ancestorPids] };
    await fs.promises.writeFile(path.join(folder, `${process.pid}.json`), JSON.stringify(entry));
    await recompute();
}

export function onTakeoverEvent(listener: (event: TakeoverEvent) => void): void {
    eventListeners.push(listener);
}

/** The interpretation overlay: splits every source pointing at our domain+main port so the middle
 *  of the deploy overlap points at the alternate port. Pure, in-memory only - the stored routing
 *  config is never modified, and this must never be applied to data that gets persisted. */
export function applyDeployRemap(routing: RemoteConfig): RemoteConfig {
    let remap = current.remap;
    let init = initialized;
    if (!remap || !init) return routing;
    let sources: RemoteConfigBase[] = [];
    let slice = (source: HostedConfig, start: number, end: number, url?: string): HostedConfig => {
        return { ...source, url: url || source.url, validWindow: [start, end] };
    };
    for (let source of routing.sources) {
        if (typeof source === "string" || source.type !== "remote") {
            sources.push(source);
            continue;
        }
        let parsed: { address: string; port: number };
        try {
            parsed = parseHostedUrl(source.url);
        } catch {
            sources.push(source);
            continue;
        }
        if (parsed.address !== init.domain || parsed.port !== init.mainPort) {
            sources.push(source);
            continue;
        }
        let [start, end] = source.validWindow;
        let a = Math.max(start, Math.min(remap.boundaryA, end));
        let b = Math.max(start, Math.min(remap.boundaryB, end));
        let added = false;
        if (a > start) {
            sources.push(slice(source, start, a));
            added = true;
        }
        if (b > a) {
            sources.push(slice(source, a, b, replaceHostedUrlPort(source.url, remap.altPort)));
            added = true;
        }
        if (end > b) {
            sources.push(slice(source, b, end));
            added = true;
        }
        if (!added) {
            sources.push(source);
        }
    }
    return { version: routing.version, sources };
}

/** A stamp of the current remap interpretation, advertised in ping responses - so every connected
 *  client learns of a takeover within one ping interval, instead of waiting for its config poll
 *  or a write rejection. */
export function getTakeoverStamp(): string | undefined {
    let remap = current.remap;
    if (!remap) return undefined;
    return JSON.stringify(remap);
}

/** For the dying process: fast-write flush delays must never extend past this time, and after it
 *  fast writes flush immediately - so nothing is left in memory when the write window transfers. */
export function getFlushDeadline(): number | undefined {
    let dying = current.dying;
    if (!dying) return undefined;
    return dying.successorStart + dying.overlap * FLUSH_DEADLINE_FRACTION;
}

/** How long to wait between main-port acquisition attempts: tight around the predecessor's
 *  scheduled death (when the port actually frees), relaxed otherwise. */
export function getMainPortAcquireDelay(): number {
    let end = current.predecessorEnd;
    if (end !== undefined && Math.abs(Date.now() - end) <= ACQUIRE_FAST_WINDOW) {
        return ACQUIRE_FAST_DELAY;
    }
    return ACQUIRE_SLOW_DELAY;
}
