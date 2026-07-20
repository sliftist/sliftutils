import fs from "fs";
import path from "path";
import { startIntermediateMaintenance } from "./storageServerState";

const PARAMETERS_TIMELINE_FILE_REGEX = /^(\d+)-parameters\.json$/;
const DEPLOY_DETECT_RETRY_DELAY = 5 * 1000;
const DEPLOY_DETECT_ATTEMPTS = 6;
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
    for (let attempt = 1; attempt <= DEPLOY_DETECT_ATTEMPTS; attempt++) {
        let entries = await readTimelineEntries();
        let found = findOurRelease(entries, Date.now());
        if (found) {
            takeover = found;
            console.log(`${logPrefix()} Our main port is in use and the deploy timeline confirms a release at ${iso(found.releaseTime)} with an overlap of ${found.overlapTime}ms: we are the successor. Our predecessor is killed at ${iso(found.releaseTime + found.overlapTime)}.`);
            return found;
        }
        console.log(`${logPrefix()} Our main port is in use but the deploy timeline in ${getTimelineFolder()} shows no release in progress (attempt ${attempt} of ${DEPLOY_DETECT_ATTEMPTS}); retrying in ${DEPLOY_DETECT_RETRY_DELAY}ms`);
        if (attempt < DEPLOY_DETECT_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, DEPLOY_DETECT_RETRY_DELAY));
        }
    }
    throw new Error(`Our main port is in use, but no deploy is in progress after ${DEPLOY_DETECT_ATTEMPTS * DEPLOY_DETECT_RETRY_DELAY}ms of checking the deploy timeline in ${getTimelineFolder()}. Something else is holding our port, so this process is in a bad state and is exiting.`);
}

export function setAltPort(port: number): void {
    if (!takeover) {
        throw new Error(`An alternate port (${port}) was taken without a detected deploy takeover - detectDeployTakeover must run first`);
    }
    takeover.altPort = port;
    console.log(`${logPrefix()} Listening on alternate port ${port}: writes route here until ${iso(getIntermediateEnd())}, and we keep listening until ${iso(getAltPortListenEnd())}`);
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
