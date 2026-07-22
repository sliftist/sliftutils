import fs from "fs";
import path from "path";
import { startIntermediateMaintenance } from "./storageServerState";

const PARAMETERS_TIMELINE_FILE_REGEX = /^(\d+)-parameters\.json$/;
const DEPLOY_DETECT_RETRY_DELAY = 5 * 1000;
const DEPLOY_DETECT_TIMEOUT = 30 * 1000;
const EXIT_LOG_FLUSH_DELAY = 5 * 1000;
const ALT_PORT_LINGER = 30 * 60 * 1000;
// The end time needs to be enough after the kill time that we are certain we will have the main port by then. Scaled up with the overlap, so unusually long overlaps get an equally generous buffer.
const INTERMEDIATE_END_MIN_BUFFER = 5 * 60 * 1000;
const ACQUIRE_SLOW_DELAY = 30 * 1000;
const ACQUIRE_FAST_DELAY = 1000;
const ACQUIRE_FAST_WINDOW = 60 * 1000;

type TimelineEntry = {
    parameters: { releaseTime?: number; overlapTime?: number };
};

type DeployTakeover = {
    releaseTime: number;
    overlapTime: number;
    altPort?: number;
    // Frozen when the alt port is taken (a moving start would make every maintenance pass write a new config)
    intermediateStart?: number;
};

let takeover: DeployTakeover | undefined;

function iso(time: number): string {
    return new Date(time).toISOString();
}

function logPrefix(): string {
    return `[pid ${process.pid}]`;
}

function getTimelineFolder(): string {
    return path.dirname(process.cwd()).replaceAll("\\", "/") + "/";
}

async function readTimelineEntries(): Promise<TimelineEntry[]> {
    let folder = getTimelineFolder();
    let files: string[];
    try {
        files = await fs.promises.readdir(folder);
    } catch (e) {
        console.warn(`${logPrefix()} Could not read the deploy timeline folder ${folder}: ${(e as Error).stack ?? e}`);
        return [];
    }
    let entries: TimelineEntry[] = [];
    for (let file of files) {
        if (!PARAMETERS_TIMELINE_FILE_REGEX.test(file)) continue;
        try {
            entries.push(JSON.parse(await fs.promises.readFile(folder + file, "utf8")) as TimelineEntry);
        } catch (e) {
            console.warn(`${logPrefix()} Could not read deploy timeline file ${folder + file}: ${(e as Error).stack ?? e}`);
        }
    }
    return entries;
}

// The newest release in the timeline is the one we are part of - the timeline is append-only history, so whatever process starts up during a takeover belongs to its latest entry
function findOurRelease(entries: TimelineEntry[]): DeployTakeover | undefined {
    let best: DeployTakeover | undefined;
    for (let entry of entries) {
        let releaseTime = entry.parameters.releaseTime;
        if (releaseTime === undefined) continue;
        let overlapTime = entry.parameters.overlapTime || 0;
        if (best && best.releaseTime >= releaseTime) continue;
        best = { releaseTime, overlapTime };
    }
    return best;
}

/** Called when the main port is already in use, which on a healthy machine only happens while our predecessor is still running a deploy overlap. Confirms that against the deploy timeline; if no deploy is in progress we are in a bad state (someone else holds our port) and the process must not keep running. */
export async function detectDeployTakeover(): Promise<DeployTakeover> {
    console.warn(`${logPrefix()} Our main port is in use, which should only happen while a deploy overlap is running - checking the deploy timeline in ${getTimelineFolder()} for the release we are part of`);
    let start = Date.now();
    let attempt = 0;
    while (true) {
        attempt++;
        let entries = await readTimelineEntries();
        let found = findOurRelease(entries);
        if (found) {
            takeover = found;
            console.warn(`${logPrefix()} Deploy takeover confirmed on attempt ${attempt}: release at ${iso(found.releaseTime)}, overlap ${found.overlapTime}ms, so our predecessor holds the main port until ${iso(found.releaseTime + found.overlapTime)}. We are the successor.`);
            return found;
        }
        let elapsed = Date.now() - start;
        if (elapsed >= DEPLOY_DETECT_TIMEOUT) {
            // Not a deploy, so something else holds our port and nothing we do from here is correct. Exit, giving the log time to reach the disk first - the message is the only thing that explains the exit.
            console.error(`${logPrefix()} Our main port is in use, but the deploy timeline in ${getTimelineFolder()} showed no release in progress across ${attempt} checks over ${elapsed}ms. Something else is holding our port, so this process is in a bad state. Exiting in ${EXIT_LOG_FLUSH_DELAY}ms.`);
            await new Promise(resolve => setTimeout(resolve, EXIT_LOG_FLUSH_DELAY));
            process.exit(1);
        }
        console.warn(`${logPrefix()} No release in progress in the deploy timeline yet (attempt ${attempt}, ${elapsed}ms of ${DEPLOY_DETECT_TIMEOUT}ms); retrying in ${DEPLOY_DETECT_RETRY_DELAY}ms`);
        await new Promise(resolve => setTimeout(resolve, DEPLOY_DETECT_RETRY_DELAY));
    }
}

export function setAltPort(port: number): void {
    if (!takeover) {
        throw new Error(`An alternate port (${port}) was taken without a detected deploy takeover - detectDeployTakeover must run first`);
    }
    takeover.altPort = port;
    // Needs to be enough after our startup time that the previous node has time to see it's going to be shut down and flush (and so we have time to start up), and enough before the kill time that nodes have time to notice we exist and prepare to connect to us - halfway between now and the kill time satisfies both
    takeover.intermediateStart = Math.round((Date.now() + getKillTime()) / 2);
    console.warn(`${logPrefix()} Listening on alternate port ${port}: writes route here from ${iso(takeover.intermediateStart)} until ${iso(getIntermediateEnd())}, and we keep listening until ${iso(getAltPortListenEnd())}`);
    startIntermediateMaintenance();
}

/** The window in which writes belong to our alternate port: from partway through the overlap (giving the predecessor notice to flush) until safely past its kill (giving us time to actually take the main port). */
export function getTakeoverIntermediate(): { start: number; end: number; altPort: number } | undefined {
    if (!takeover?.altPort || takeover.intermediateStart === undefined) return undefined;
    return { start: takeover.intermediateStart, end: getIntermediateEnd(), altPort: takeover.altPort };
}

/** When our predecessor is killed and the main port frees. Port acquisition polls against this on its own - it is entirely independent of the intermediate window. */
function getKillTime(): number {
    if (!takeover) return 0;
    return takeover.releaseTime + takeover.overlapTime;
}

function getIntermediateEnd(): number {
    if (!takeover) return 0;
    return getKillTime() + Math.max(INTERMEDIATE_END_MIN_BUFFER, takeover.overlapTime);
}

/** We never stop listening on the alternate port while its window is still valid, and hold it well past that for clients that have not caught up yet. */
export function getAltPortListenEnd(): number {
    if (!takeover) return 0;
    return Math.max(takeover.releaseTime + takeover.overlapTime * 2, getIntermediateEnd() + ALT_PORT_LINGER);
}

/** How long to wait between main-port acquisition attempts: tight around our predecessor's scheduled death (when the port actually frees), relaxed otherwise. */
export function getMainPortAcquireDelay(): number {
    if (!takeover) return ACQUIRE_SLOW_DELAY;
    if (Date.now() >= getKillTime() - ACQUIRE_FAST_WINDOW) {
        return ACQUIRE_FAST_DELAY;
    }
    return ACQUIRE_SLOW_DELAY;
}
