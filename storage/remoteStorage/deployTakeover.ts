import fs from "fs";
import path from "path";
import { startIntermediateMaintenance } from "./storageServerState";

const PARAMETERS_TIMELINE_FILE_REGEX = /^(\d+)-parameters\.json$/;
const DEPLOY_DETECT_RETRY_DELAY = 5 * 1000;
const DEPLOY_DETECT_TIMEOUT = 30 * 1000;
const EXIT_LOG_FLUSH_DELAY = 5 * 1000;
const DEPLOY_RELEASE_MATCH_WINDOW = 5 * 60 * 1000;
const ALT_PORT_LINGER = 30 * 60 * 1000;
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

function findOurRelease(entries: TimelineEntry[], now: number): DeployTakeover | undefined {
    let best: DeployTakeover | undefined;
    for (let entry of entries) {
        let releaseTime = entry.parameters.releaseTime;
        if (releaseTime === undefined) continue;
        let overlapTime = entry.parameters.overlapTime || 0;
        if (releaseTime > now + DEPLOY_RELEASE_MATCH_WINDOW) continue;
        if (now > releaseTime + overlapTime + DEPLOY_RELEASE_MATCH_WINDOW) continue;
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
        let found = findOurRelease(entries, Date.now());
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
    console.warn(`${logPrefix()} Listening on alternate port ${port}: writes route here until ${iso(getIntermediateEnd())}, and we keep listening until ${iso(getAltPortListenEnd())}. Writing the switchover windows into every bucket now.`);
    startIntermediateMaintenance();
}

/** The window in which writes belong to our alternate port: from the release until our predecessor is killed and we take the main port. */
export function getTakeoverIntermediate(): { start: number; end: number; altPort: number } | undefined {
    if (!takeover?.altPort) return undefined;
    return { start: takeover.releaseTime, end: getIntermediateEnd(), altPort: takeover.altPort };
}

function getIntermediateEnd(): number {
    if (!takeover) return 0;
    return takeover.releaseTime + takeover.overlapTime;
}

/** We never stop listening on the alternate port while its window is still valid, and hold it well past that for clients that have not caught up yet. */
export function getAltPortListenEnd(): number {
    if (!takeover) return 0;
    return Math.max(takeover.releaseTime + takeover.overlapTime * 2, getIntermediateEnd() + ALT_PORT_LINGER);
}

/** How long to wait between main-port acquisition attempts: tight around our predecessor's scheduled death (when the port actually frees), relaxed otherwise. */
export function getMainPortAcquireDelay(): number {
    if (!takeover) return ACQUIRE_SLOW_DELAY;
    let predecessorEnd = takeover.releaseTime + takeover.overlapTime;
    if (Date.now() >= predecessorEnd - ACQUIRE_FAST_WINDOW) {
        return ACQUIRE_FAST_DELAY;
    }
    return ACQUIRE_SLOW_DELAY;
}
