import { lazy } from "socket-function/src/caching";
import { formatDateTimeDetailed } from "socket-function/src/formatting/format";
import { runInfinitePoll } from "socket-function/src/batching";
import { RemoteConfig, SourceConfig, HostedConfig } from "../IArchives";
import { ROUTING_FILE, getConfigVersion, serializeRemoteConfig, parseRoutingData, parseHostedUrl, replaceHostedUrlPort } from "./remoteConfig";
import { injectIntermediateSource, expireIntermediateSources, getIntermediateSources, nextIntermediateVersion, INTERMEDIATE_EXPIRE_GRACE } from "./intermediateSources";
import { getTakeoverIntermediate } from "./deployTakeover";
import { getStorageServerConfig } from "./serverConfig";
import { createApiArchives, listServerActiveBucketKeys } from "./createArchives";
import { findSelfIndexes, previousWindowOwners } from "./storePlan";
import { getActiveBucketKeys, getStore, activateBucket, writeRoutingConfig } from "./storageServerState";
import { readRoutingFromDisk, readNewestRoutingFile } from "./bucketDisk";
import { DEFAULT_FAST_WRITE_DELAY } from "./ArchivesDelayed";
import { WINDOW_END_FLUSH_MARGIN } from "./blobStore";

// Deploy switchovers, and the handovers they cause. A switchover is a source moving to a new port for a few minutes: we give it a virtual valid window on that port (an "intermediate"), which means the write target changes twice in quick succession, which means the store taking over has to go and collect the writes that landed just before it did. None of that is storage - it is scheduling - so it lives here rather than in the store or in the server's bucket state.

const MAX_TIMER_DELAY = 2 ** 31 - 1;
const BOUNDARY_BUFFER = 1000;
// A handover is scanned just before the boundary, just after, and again a little later - the last writes to the old target can land after the boundary itself
const BOUNDARY_SCAN_OFFSETS = [-30 * 1000, 2 * 1000, 30 * 1000];
// How far back a boundary scan asks for changes: everything that could still have been buffered when the window ended
const BOUNDARY_SCAN_LOOKBACK = DEFAULT_FAST_WRITE_DELAY + WINDOW_END_FLUSH_MARGIN;
const STARTUP_BOUNDARY_SCAN_DELAY = 30 * 1000;
const OWN_CONFIG_WRITE_THROTTLE = 30 * 1000;
const INTERMEDIATE_MAINTAIN_INTERVAL = 60 * 1000;

const scheduledBoundaryScans = new Set<string>();
const boundaryScansRunning = new Set<string>();

/** Called every time a store applies a routing config to itself (see BlobStore's onRoutingApplied): arms the scans the config's upcoming window boundaries need. Each scan is scheduled once - the key includes the boundary it is for - so re-arming on every config application is harmless. */
export function scheduleBoundaryWork(account: string, bucketName: string, routing: RemoteConfig): void {
    let key = `${account}/${bucketName}`;
    let selfEntries = findSelfIndexes(routing, account, bucketName).map(i => routing.sources[i] as HostedConfig);
    let now = Date.now();
    let starts = new Set<number>();
    for (let self of selfEntries) {
        let start = self.validWindow[0];
        if (start > now && start < Number.MAX_SAFE_INTEGER) {
            starts.add(start);
        }
    }
    // A window we have only just taken over, on a server that has only just started: the boundary happened while we were not running, so its scan still has to happen
    for (let self of selfEntries) {
        let [start, end] = self.validWindow;
        if (!(start <= now && now < end) || start <= 0) continue;
        if (now - start > BOUNDARY_SCAN_LOOKBACK) continue;
        let scheduleKey = `${key}|${start}|startup`;
        if (scheduledBoundaryScans.has(scheduleKey)) continue;
        scheduledBoundaryScans.add(scheduleKey);
        let timer = setTimeout(() => {
            void runBoundaryScan(account, bucketName, start, STARTUP_BOUNDARY_SCAN_DELAY, "startup+30s").catch((e: Error) => console.error(`Boundary scan for bucket ${key} failed: ${e.stack ?? e}`));
        }, STARTUP_BOUNDARY_SCAN_DELAY);
        (timer as { unref?: () => void }).unref?.();
    }
    for (let start of starts) {
        for (let offset of BOUNDARY_SCAN_OFFSETS) {
            let at = start + offset;
            if (at <= now) continue;
            let scheduleKey = `${key}|${start}|${offset}`;
            if (scheduledBoundaryScans.has(scheduleKey)) continue;
            scheduledBoundaryScans.add(scheduleKey);
            // Re-armed rather than trusted: a long timer can fire early after a suspend, and firing early would scan for a handover that has not happened
            let arm = () => {
                let timer = setTimeout(() => {
                    if (Date.now() < at) {
                        arm();
                        return;
                    }
                    void runBoundaryScan(account, bucketName, start, offset).catch((e: Error) => console.error(`Boundary scan for bucket ${key} failed: ${e.stack ?? e}`));
                }, Math.min(at - Date.now(), MAX_TIMER_DELAY));
                (timer as { unref?: () => void }).unref?.();
            };
            arm();
        }
    }
}

/** Collects the writes that landed on the previous window's owners just before a boundary, into the store that has just taken over. Who owned what is worked out purely from the config (see previousWindowOwners); this only does the pulling. The config is read off the disk at FIRE time, not captured when the scan was armed - it may have changed in between, and the newest copy is the one the handover actually happened under. */
async function runBoundaryScan(account: string, bucketName: string, windowStart: number, offset: number, offsetLabel?: string): Promise<void> {
    let key = `${account}/${bucketName}`;
    let label = `bucket ${key}, window starting ${formatDateTimeDetailed(windowStart)}, offset ${offsetLabel || `${offset / 1000}s`}`;
    if (boundaryScansRunning.has(key)) {
        console.log(`Skipping boundary scan (${label}): the previous boundary scan is still running`);
        return;
    }
    boundaryScansRunning.add(key);
    try {
        let effective = await readRoutingFromDisk(account, bucketName);
        if (!effective) return;
        let handovers = previousWindowOwners(effective, windowStart, findSelfIndexes(effective, account, bucketName));
        if (!handovers.length) return;
        console.log(`Boundary scan (${label}): ${handovers.length} route(s) taking over: ${handovers.map(x => `${JSON.stringify(x.route)} from ${x.scanOwnDisk && "our own disk" || ""}${x.scanOwnDisk && x.remotes.size && " + " || ""}${[...x.remotes.keys()].map(i => `source ${i}`).join(", ")}`).join("; ")}`);
        let since = windowStart - BOUNDARY_SCAN_LOOKBACK;
        for (let handover of handovers) {
            let selfStore = getStore(account, bucketName, handover.name);
            if (handover.scanOwnDisk) {
                await selfStore.rescanBase();
            }
            for (let [sourceIndex, route] of handover.remotes) {
                let ownerSource = effective.sources[sourceIndex];
                if (typeof ownerSource === "string") continue;
                try {
                    await selfStore.boundaryScanRemote(createApiArchives(ownerSource), { since, route });
                } catch (e) {
                    console.error(`Boundary scan (${label}) of previous-window owner (source index ${sourceIndex}) failed: ${(e as Error).stack ?? e}`);
                }
            }
        }
    } finally {
        boundaryScansRunning.delete(key);
    }
}

/** An operator's config knows nothing about a switchover that is in flight right now, so writing it as-is would cancel one mid-handover. The in-flight windows are put back into it first. */
export function reinjectIntermediates(current: RemoteConfig | undefined, incoming: RemoteConfig): RemoteConfig {
    if (!current) return incoming;
    let stored = incoming;
    let reinjected = 0;
    for (let intermediate of getIntermediateSources(expireIntermediateSources(current, Date.now()))) {
        stored = injectIntermediateSource(stored, {
            splitUrl: intermediate.intermediate || intermediate.url,
            intermediateUrl: intermediate.url,
            start: intermediate.validWindow[0],
            end: intermediate.validWindow[1],
        });
        reinjected++;
    }
    if (reinjected) {
        console.log(`Re-injected ${reinjected} in-flight switchover window(s) into an incoming routing config (version ${getConfigVersion(incoming)})`);
    }
    return stored;
}

// Per bucket, not global: a switchover has to write every bucket's windows at once, and a shared throttle would let only one bucket through per interval
const lastOwnConfigWrite = new Map<string, number>();

async function writeOwnRoutingConfig(config: { account: string; bucketName: string; storeName: string; current: RemoteConfig; updated: RemoteConfig; reason: string }): Promise<void> {
    let { account, bucketName, current, updated, reason } = config;
    let key = `${account}/${bucketName}`;
    let sinceLast = Date.now() - (lastOwnConfigWrite.get(key) || 0);
    if (sinceLast < OWN_CONFIG_WRITE_THROTTLE) {
        console.log(`Not writing our own routing config update for bucket ${key} (${reason}): the last one was ${sinceLast}ms ago, under the ${OWN_CONFIG_WRITE_THROTTLE}ms throttle. Retrying on the next maintenance pass.`);
        return;
    }
    lastOwnConfigWrite.set(key, Date.now());
    let currentVersion = getConfigVersion(current);
    let version = nextIntermediateVersion(currentVersion);
    let next: RemoteConfig = { ...updated, version };
    console.log(`Writing ${ROUTING_FILE} for bucket ${key} (${reason}), version ${currentVersion} -> ${version}: ${JSON.stringify(next)}`);
    let data = Buffer.from(serializeRemoteConfig(next));
    // Into the store holding the newest copy - it applies it and its peers pull it - and directly to the other servers, which is what makes a switchover take effect in seconds rather than at the next poll
    await writeRoutingConfig(account, bucketName, config.storeName, data);
    await propagateRoutingConfig({ account, bucketName, current, next, data });
}

async function propagateRoutingConfig(config: { account: string; bucketName: string; current: RemoteConfig; next: RemoteConfig; data: Buffer }): Promise<void> {
    let targets = new Map<string, SourceConfig>();
    for (let source of [...config.current.sources, ...config.next.sources]) {
        if (typeof source === "string" || source.intermediate) continue;
        if (source.type === "remote") {
            let parsed = parseHostedUrl(source.url);
            if (parsed.account !== config.account || parsed.bucketName !== config.bucketName) continue;
        }
        if (targets.has(source.url)) continue;
        targets.set(source.url, source);
    }
    for (let [url, source] of targets) {
        try {
            await createApiArchives(source).set(ROUTING_FILE, config.data);
            console.log(`Wrote ${ROUTING_FILE} for bucket ${config.account}/${config.bucketName} to ${url}`);
        } catch (e) {
            console.error(`Propagating our routing config update to ${url} failed: ${(e as Error).stack ?? e}`);
        }
    }
}

/** Keeps every active bucket's switchover windows current: gives our alternate port its window while a takeover is in flight, and takes expired ones back out. */
async function maintainIntermediates(): Promise<void> {
    let { domain, port } = getStorageServerConfig();
    let takeover = getTakeoverIntermediate();
    let written: string[] = [];
    let alreadyCorrect: string[] = [];
    let notOurs: string[] = [];
    // ONLY buckets already active. A switchover must never activate a bucket: that starts its synchronization, and buckets nothing has touched (legacy ones especially) have no writes to hand off in the first place. One that does get used mid-switchover activates on that access, and the next pass gives it its window.
    let activeKeys = getActiveBucketKeys();
    for (let { account, bucketName } of activeKeys) {
        let key = `${account}/${bucketName}`;
        let newest = await readNewestRoutingFile(account, bucketName);
        if (!newest) continue;
        let routing = parseRoutingData(newest.data);
        if (!routing) {
            console.error(`Skipping switchover maintenance for bucket ${key}: its routing config could not be parsed`);
            continue;
        }
        let expired = expireIntermediateSources(routing, Date.now());
        if (JSON.stringify(expired) !== JSON.stringify(routing)) {
            await writeOwnRoutingConfig({ account, bucketName, storeName: newest.name, current: routing, updated: expired, reason: `switchover windows expired more than ${INTERMEDIATE_EXPIRE_GRACE / 1000}s ago` });
            written.push(key);
            continue;
        }
        if (!takeover) continue;
        let mainUrl = routing.sources.find(x => {
            if (typeof x === "string" || x.type !== "remote" || x.intermediate) return false;
            let parsed = parseHostedUrl(x.url);
            return parsed.address === domain && parsed.port === port;
        }) as HostedConfig | undefined;
        if (!mainUrl) {
            notOurs.push(key);
            continue;
        }
        let injected = injectIntermediateSource(routing, {
            splitUrl: mainUrl.url,
            intermediateUrl: replaceHostedUrlPort(mainUrl.url, takeover.altPort),
            start: takeover.start,
            end: takeover.end,
        });
        if (JSON.stringify(injected) === JSON.stringify(routing)) {
            alreadyCorrect.push(key);
            continue;
        }
        await writeOwnRoutingConfig({ account, bucketName, storeName: newest.name, current: routing, updated: injected, reason: `we are a deploy successor: writes route to our alternate port ${takeover.altPort} from ${formatDateTimeDetailed(takeover.start)} until our predecessor is killed at ${formatDateTimeDetailed(takeover.end)}` });
        written.push(key);
    }
    if (!takeover) return;
    if (!activeKeys.length) {
        console.log(`No active buckets, so no config files to write the intermediate into (a bucket is only active once something uses it)`);
        return;
    }
    if (!written.length) {
        console.log(`Wrote no config files: of ${activeKeys.length} active buckets, ${alreadyCorrect.length} already contain the intermediate and ${notOurs.length} are not hosted by us`);
    }
}

/** Our predecessor still holds the main port and has been serving all along, so it - not us - knows which buckets are in use. We activate exactly those, which is what makes their config files get the intermediate; nothing else on disk is touched. */
async function activatePredecessorBuckets(): Promise<void> {
    let { domain, port } = getStorageServerConfig();
    let url = `https://${domain}:${port}`;
    let keys: { account: string; bucketName: string }[];
    try {
        keys = await listServerActiveBucketKeys({ url });
    } catch (e) {
        console.error(`Could not ask our predecessor on ${url} which buckets are active, so only buckets used on this process get the intermediate: ${(e as Error).stack ?? e}`);
        return;
    }
    if (!keys.length) {
        console.log(`Our predecessor on ${url} has no active buckets, so there are no config files to write the intermediate into`);
        return;
    }
    console.log(`Our predecessor on ${url} has ${keys.length} active buckets, activating them here so their config files get the intermediate: ${keys.map(x => `${x.account}/${x.bucketName}`).join(", ")}`);
    for (let { account, bucketName } of keys) {
        try {
            let result = await activateBucket(account, bucketName);
            if (typeof result === "string") {
                console.error(`Activating bucket ${account}/${bucketName} (active on our predecessor) failed: ${result}`);
            }
        } catch (e) {
            console.error(`Activating bucket ${account}/${bucketName} (active on our predecessor) failed: ${(e as Error).stack ?? e}`);
        }
    }
}

/** Started by deployTakeover once we are actually a deploy successor listening on an alternate port. Until then there are no switchover windows to write or expire, so nothing polls. */
export const startIntermediateMaintenance = lazy(() => {
    void (async () => {
        await activatePredecessorBuckets();
        await maintainIntermediates();
    })().catch((e: Error) => console.error(`Writing the intermediate into the config files failed: ${e.stack ?? e}`));
    runInfinitePoll(INTERMEDIATE_MAINTAIN_INTERVAL, maintainIntermediates);
});
