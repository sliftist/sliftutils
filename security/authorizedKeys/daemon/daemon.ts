import fs from "fs/promises";
import os from "os";
import { configureDiscordNotifications, DEFAULT_WEBHOOK_FILE_PATH } from "../../notifications/discord";
import { findSourceKey, legacySourceKeyPath, sourceKeyPath, sourceRepoPath } from "../sources";
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
import { absorbRevocations, applyUnrevokes, pairKey, recordRevocation, removeRevokedKeys } from "./revocation";
import { revokeRepo, syncRepoFiles } from "./repoFiles";
import { revokeRepoURL } from "../revokeSource";
import { keyFingerprint } from "../authorizedKeys";
import { addChangeReason } from "./changes";
import { checkOtherUserKeys, seedUserKeys } from "./userKeys";

// portsecure authorized-keys daemon.
//
// It owns root's authorized_keys: the contents come from one or more git repos, anything else is
// reverted, and password authentication is turned off so those repos are the only way in.
//
// The complete list of things that send a Discord message. Nothing else may be added to it
// without the user asking for that specific case - everything else goes to the log.
//
// Anything that changes which keys root may use says nothing at the time. It leaves its reason
// with addChangeReason, the file is written, and if it came out different that one message carries
// the difference and every reason behind it. Announcing at the point of deciding is what produced
// several messages for one event, and messages about removing a key that was already gone.
//   1. root's authorized_keys changed, with what changed and why: a key revoked here, a revocation
//      published elsewhere, an unrevoke taking effect, a source moving on.
//   2. root's authorized_keys was edited by something else, and was put back.
//   3. Another user's authorized_keys changed. A different file, and not one we manage.
//   4. A source's history was rewritten.
//   5. A source started being signed by a different key, so its new keys are being held.
//   6. A source is now signed when it was not before, applied right away.
//   7. A source changed without its signature being updated, so the change is ignored.
//   8. A source has a corrupted signature, so its contents are ignored.
//   9. The webhook file itself changed, reported to the webhook being replaced.
//  10. A trusted machine talked to us from an address it is not allowed from, so it was frozen
//      everywhere. Sent by whichever machine wrote that revocation, from machines.ts.

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
        if (!await findSourceKey(repoURL)) {
            console.error(
                `portsecure: expected the private key for ${repoURL} at ${sourceKeyPath(repoURL)}`
                + ` or ${legacySourceKeyPath(repoURL)}, neither exists`
            );
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
        // A key and the address it was used from. The same pair twice is one revocation, but the
        // same key from somewhere else is a new event, whatever was forgiven before.
        let pair = pairKey({ fingerprint: found.fingerprint, ip: found.attempt.ip });
        if (Object.values(state.revocations).some(revocation => pairKey(revocation) === pair)) {
            continue;
        }
        if (state.pendingRevocations.some(pending => pairKey({ fingerprint: pending.fingerprint, ip: pending.attempt.ip }) === pair)) {
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
            let known = () => Object.values(state.revocations)
                .some(revocation => pairKey(revocation) === pairKey({ fingerprint: pending.fingerprint, ip: pending.attempt.ip }));
            if (known()) {
                continue;
            }
            let recorded = await recordRevocation({ ...pending, hostLabel: config.hostLabel });
            if (!recorded && !known()) {
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
            await cloneRepo({ repoURL, repoPath: sourceRepoPath(repoURL), keyPath: await findSourceKey(repoURL) || sourceKeyPath(repoURL) });
            repoFailureCounts[repoURL] = 0;
            return true;
        } catch (cloneError) {
            console.log(`${repoURL} cannot be reached or cloned, its last known keys stay in place. ${cloneError}`);
            return false;
        }
    }

    if (result.historyRewritten) {
        await notify(`KEY REPO HISTORY REWRITTEN`,
            `Commits that used to be in \`${repoURL}\` are gone, so somebody force pushed over it`
            + ` or tampered with it. Whatever it says now has been applied.`
            + `\n\nwas at: \`${result.previousSha.slice(0, 12)}\``
            + `\nnow at: \`${result.remoteSha.slice(0, 12)}\``
        );
    }
    if (!result.changed) {
        return false;
    }
    // Said when the file is written, and only if it came out different. A commit that does not
    // touch the keys is not worth telling anyone about.
    addChangeReason(`The key repo \`${repoURL}\` moved to \`${result.remoteSha.slice(0, 12)}\`.`);
    sourceState(repoURL).lastSha = result.remoteSha;
    return true;
}

/** The one loop. Every repo this machine reads is brought up to date here: each source, and the
    revoke repo beside it that says which of its keys are no longer accepted.

    A repo that cannot be read is reported and skipped, and nothing downstream may read that as an
    answer. An unreachable source keeps the keys it last gave us, and an unreachable revoke repo
    keeps the revocations we already know - the alternative is one network failure emptying
    authorized_keys, or handing a revoked key back to every machine. */
async function everyCheck() {
    let anyChanged = false;
    for (let repoURL of config.repoSources) {
        // One unreachable source must not stop the others from being checked.
        try {
            anyChanged = await pollSource(repoURL) || anyChanged;
        } catch (e) {
            console.error(`Polling ${repoURL} failed, its last known keys stay in place. ${e && (e as Error).stack || e}`);
        }
        try {
            await syncRepoFiles(revokeRepo(repoURL));
        } catch (e) {
            console.error(
                `Could not read ${revokeRepoURL(repoURL)}, the revocations already known stay in place. ${e}`
            );
        }
    }
    if (anyChanged) {
        await saveState();
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

    // Whatever other users already have, before the first check, so what is there at startup is
    // not reported as somebody having just changed it.
    await seedUserKeys();

    // configureDiscordNotifications watches the webhook file on its own, so there is nothing to
    // schedule for it here.
    let runCheck = startInterval({ name: "check", intervalTime: CHECK_INTERVAL, run: everyCheck });
    // The same check as every other, run once now rather than a minute from now: a machine has to
    // be correct immediately after boot. Running the one function, rather than a startup copy of
    // it, is what keeps a step from being left out of one of them - the copy here had no
    // applyUnrevokes, so every restart re-applied a revocation that had already been undone.
    await runCheck();

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
