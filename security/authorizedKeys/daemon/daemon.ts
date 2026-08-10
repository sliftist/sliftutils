import fs from "fs/promises";
import os from "os";
import { configureDiscordNotifications, DEFAULT_WEBHOOK_FILE_PATH } from "../../notifications/discord";
import { sourceKeyPath, sourceRepoPath } from "../sources";
import { cloneRepo, syncRepo } from "./git";
import {
    CHECK_INTERVAL,
    CONFIG_PATH,
    MAX_REPO_FAILURES_BEFORE_RECLONE,
    ROOT_AUTHORIZED_KEYS,
} from "./paths";
import { notify, setHostLabel } from "./notify";
import { enforceRootKeys } from "./rootKeys";
import { enforceSSHDConfig } from "./sshdConfig";
import { getState, loadState, saveState, sourceState } from "./state";
import { resolveSourceKeys } from "./trust";
import { parseAuthLog, readNewAuthLog, watchAuthLog } from "./authLog";
import { absorbRevocations, applyUnrevokes, recordRevocation, removeRevokedKeys, syncRevokeRepo } from "./revocation";
import { keyFingerprint } from "../authorizedKeys";
import { checkOtherUserKeys, seedUserKeys } from "./userKeys";

// portsecure authorized-keys daemon.
//
// It owns root's authorized_keys: the contents come from one or more git repos, anything else is
// reverted, and password authentication is turned off so those repos are the only way in.
//
// The complete list of things that send a Discord message. Nothing else may be added to it
// without the user asking for that specific case - everything else goes to the log.
//   1. root's authorized_keys was changed outside portsecure, and was reverted.
//   2. root's authorized_keys was updated because a source changed.
//   3. Another user's authorized_keys changed.
//   4. A source's history was rewritten.
//   5. A source started being signed by a different key, so its new keys are being held.
//   6. A source is now signed when it was not before, applied right away.
//   7. A source changed without its signature being updated, so the change is ignored.
//   8. A source has a corrupted signature, so its contents are ignored.
//   9. The webhook file itself changed, reported to the webhook being replaced.
//  10. A key was revoked here, after being used from an address it is not allowed from.
//  11. A revoked key was removed from root's authorized_keys, said once per key.
//  12. An unrevoke was published, and is being held for an hour.
//  13. An unrevoke was applied once that hour passed.

export type DaemonConfig = {
    repoSources: string[];
    hostLabel: string;
};

let config: DaemonConfig = { repoSources: [], hostLabel: "" };
let repoFailureCounts: { [repoURL: string]: number } = {};

export function getConfig() {
    return config;
}

export function setConfig(value: DaemonConfig) {
    config = value;
    setHostLabel(value.hostLabel);
}

async function loadConfig(): Promise<DaemonConfig> {
    let contents;
    try {
        contents = await fs.readFile(CONFIG_PATH, "utf8");
    } catch (e) {
        console.error(`portsecure: expected a config file at ${CONFIG_PATH}, ${e}`);
        process.exit(1);
    }
    let parsed = JSON.parse(contents) as { repoSources?: string[]; hostLabel?: string };
    if (!Array.isArray(parsed.repoSources)) {
        console.error(`portsecure: expected a repoSources array in ${CONFIG_PATH}, was ${JSON.stringify(parsed.repoSources)}`);
        process.exit(1);
    }
    for (let repoURL of parsed.repoSources) {
        try {
            await fs.access(sourceKeyPath(repoURL));
        } catch (e) {
            console.error(`portsecure: expected the private key for ${repoURL} at ${sourceKeyPath(repoURL)}, ${e}`);
            process.exit(1);
        }
    }
    return {
        repoSources: parsed.repoSources,
        // The machine knows its own name, the config only overrides it when a nicer label helps.
        hostLabel: parsed.hostLabel || os.hostname(),
    };
}

/** The union of every source, in source order, with duplicates dropped. A source that cannot be
    read is skipped rather than emptying the merged set, so one broken repo cannot revoke the keys
    that came from the others. */
export async function readAllowedKeys() {
    let keys: string[] = [];
    let seen = new Set<string>();
    for (let repoURL of config.repoSources) {
        let sourceKeys: string[];
        try {
            sourceKeys = await resolveSourceKeys(repoURL);
        } catch (e) {
            console.log(`Skipping ${repoURL}, its checkout could not be read. ${e}`);
            continue;
        }
        for (let key of sourceKeys) {
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            keys.push(key);
        }
    }
    return keys;
}

/** Which source contributed a key, so its revocation is written to that source's revoke repo. */
function sourceOfFingerprint(fingerprint: string) {
    for (let repoURL of config.repoSources) {
        if (sourceState(repoURL).acceptedKeys.some(key => keyFingerprint(key) === fingerprint)) {
            return repoURL;
        }
    }
    return config.repoSources[0] || "";
}

/** Anything sshd refused because of a from= restriction gets that key revoked everywhere. Reading
    the log is cheap and local, and the fingerprint is checked against what we already revoked
    before any network work happens.

    A refusal is queued rather than acted on directly, because the log is read once and moves past:
    if the revoke repo is unreachable at that moment, dropping the refusal would leave a key that
    was misused accepted forever. The queue is retried until it is written down. */
async function queueRefusedKeys(allowedKeys: string[]) {
    let contents = await readNewAuthLog();
    if (!contents.trim()) {
        return;
    }
    let state = getState();
    for (let found of parseAuthLog(contents)) {
        // One key is revoked once, no matter how many addresses it was tried from.
        if (state.revocations[found.fingerprint]) {
            continue;
        }
        if (state.pendingRevocations.some(pending => pending.fingerprint === found.fingerprint)) {
            continue;
        }
        let sourceURL = sourceOfFingerprint(found.fingerprint);
        if (!sourceURL) {
            console.log(`Nowhere to record the revocation of ${found.fingerprint}, no sources are configured`);
            continue;
        }
        console.log(`Queued the revocation of ${found.fingerprint}, used from ${found.attempt.ip}`);
        state.pendingRevocations.push({
            fingerprint: found.fingerprint,
            keyLine: allowedKeys.find(key => keyFingerprint(key) === found.fingerprint) || "",
            sourceURL,
            attempt: found.attempt,
        });
    }
    await saveState();
}

// The log watcher and the periodic check both reach this, and two of them pushing to the same
// revoke repo at once would only fight each other.
let writingQueued = false;

/** Writes down everything queued that we have not managed to write down yet. */
async function writeQueuedRevocations() {
    let state = getState();
    if (!state.pendingRevocations.length || writingQueued) {
        return;
    }
    writingQueued = true;
    try {
        let remaining = [];
        for (let pending of state.pendingRevocations) {
            if (state.revocations[pending.fingerprint]) {
                continue;
            }
            let recorded = await recordRevocation({ ...pending, hostLabel: config.hostLabel });
            if (!recorded && !state.revocations[pending.fingerprint]) {
                remaining.push(pending);
            }
        }
        state.pendingRevocations = remaining;
        await saveState();
    } finally {
        writingQueued = false;
    }
}

/** Everything the arrival of a refused login needs: read what is new, queue it, write it down.
    Kept small, and off the merged key set the periodic check rebuilds, so reacting to a log line
    cannot race that check. */
async function onAuthLogChanged() {
    await queueRefusedKeys(getState().appliedKeys);
    await writeQueuedRevocations();
}

/** Syncs one source. Returns whether the merged keys need reapplying. */
async function pollSource(repoURL: string) {
    let result;
    try {
        result = await syncRepo(repoURL);
        repoFailureCounts[repoURL] = 0;
    } catch (e) {
        let failures = (repoFailureCounts[repoURL] || 0) + 1;
        repoFailureCounts[repoURL] = failures;
        console.log(`Sync of ${repoURL} failed (${failures} in a row). ${e}`);
        if (failures < MAX_REPO_FAILURES_BEFORE_RECLONE) {
            return false;
        }
        // Availability over tidiness: throw the working copy away and start again.
        console.log(`Discarding the checkout of ${repoURL} and cloning from scratch`);
        try {
            await cloneRepo({ repoURL, repoPath: sourceRepoPath(repoURL), keyPath: sourceKeyPath(repoURL) });
            repoFailureCounts[repoURL] = 0;
            return true;
        } catch (cloneError) {
            console.log(`${repoURL} cannot be reached or cloned, its last known keys stay in place. ${cloneError}`);
            return false;
        }
    }

    if (result.historyRewritten) {
        await notify(
            `the history of \`${repoURL}\` was rewritten. Commit \`${result.previousSha.slice(0, 12)}\` is no`
            + ` longer an ancestor of \`${result.remoteSha.slice(0, 12)}\`, so history was force pushed or`
            + ` tampered with. The new state has been applied.`
        );
    }
    if (!result.changed) {
        return false;
    }
    sourceState(repoURL).lastSha = result.remoteSha;
    return true;
}

async function everyCheck() {
    let anyChanged = false;
    for (let repoURL of config.repoSources) {
        // One unreachable source must not stop the others from being checked.
        try {
            anyChanged = await pollSource(repoURL) || anyChanged;
        } catch (e) {
            console.log(`Polling ${repoURL} failed. ${e && (e as Error).stack || e}`);
        }
    }
    if (anyChanged) {
        await saveState();
    }

    // What other machines have revoked, and anything published to undo a revocation.
    for (let repoURL of config.repoSources) {
        await syncRevokeRepo(repoURL);
    }
    await absorbRevocations(config.repoSources);
    await applyUnrevokes(config.repoSources);

    let mergedKeys = await readAllowedKeys();
    // The log is watched, not polled. This is only the retry for anything that could not be
    // written down when it happened, because the revoke repo was unreachable.
    await writeQueuedRevocations();

    await enforceRootKeys(await removeRevokedKeys(mergedKeys));
    await checkOtherUserKeys();
    await enforceSSHDConfig();
}

function startInterval(config: { intervalTime: number; run: () => Promise<void>; name: string }) {
    let { intervalTime, run, name } = config;
    let running = false;
    let tick = async () => {
        if (running) {
            console.log(`Skipping ${name}, the previous run has not finished`);
            return;
        }
        running = true;
        try {
            await run();
        } catch (e) {
            // Every scheduled job swallows its own errors, the daemon must outlive any single one.
            console.log(`${name} failed. ${e && (e as Error).stack || e}`);
        }
        running = false;
    };
    setInterval(tick, intervalTime);
    return tick;
}

export async function main() {
    setConfig(await loadConfig());
    await loadState();
    await configureDiscordNotifications({ filePath: DEFAULT_WEBHOOK_FILE_PATH });

    console.log(`Starting, ${config.repoSources.length} source(s), keys applied to ${ROOT_AUTHORIZED_KEYS}`);

    // A first pass has to happen before the intervals, so a machine is correct immediately after
    // boot rather than a minute later.
    for (let repoURL of config.repoSources) {
        try {
            sourceState(repoURL).lastSha = (await syncRepo(repoURL)).remoteSha;
        } catch (e) {
            console.log(`Initial sync of ${repoURL} failed, continuing with whatever is on disk. ${e}`);
        }
    }
    await saveState();
    await seedUserKeys();

    for (let repoURL of config.repoSources) {
        await syncRevokeRepo(repoURL);
    }
    await absorbRevocations(config.repoSources);
    await enforceRootKeys(await removeRevokedKeys(await readAllowedKeys()));
    await enforceSSHDConfig();

    // configureDiscordNotifications watches the webhook file on its own, so there is nothing to
    // schedule for it here.
    startInterval({ name: "check", intervalTime: CHECK_INTERVAL, run: everyCheck });

    // A refused login is acted on when sshd writes it. The one pass here covers anything written
    // while the daemon was not running.
    let readAuthLogNow = watchAuthLog(onAuthLogChanged);
    await readAuthLogNow();
}

process.on("uncaughtException", e => console.log(`Uncaught exception, staying up. ${e && e.stack || e}`));
process.on("unhandledRejection", e => console.log(`Unhandled rejection, staying up. ${e}`));
process.on("SIGTERM", () => {
    console.log("Received SIGTERM, exiting");
    process.exit(0);
});
