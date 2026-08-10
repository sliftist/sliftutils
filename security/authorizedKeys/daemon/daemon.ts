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
import { log, notify, setHostLabel } from "./notify";
import { enforceRootKeys } from "./rootKeys";
import { enforceSSHDConfig } from "./sshdConfig";
import { getState, loadState, saveState, sourceState } from "./state";
import { resolveSourceKeys } from "./trust";
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
            log(`Skipping ${repoURL}, its checkout could not be read. ${e}`);
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

/** Syncs one source. Returns whether the merged keys need reapplying. */
async function pollSource(repoURL: string) {
    let result;
    try {
        result = await syncRepo(repoURL);
        repoFailureCounts[repoURL] = 0;
    } catch (e) {
        let failures = (repoFailureCounts[repoURL] || 0) + 1;
        repoFailureCounts[repoURL] = failures;
        log(`Sync of ${repoURL} failed (${failures} in a row). ${e}`);
        if (failures < MAX_REPO_FAILURES_BEFORE_RECLONE) {
            return false;
        }
        // Availability over tidiness: throw the working copy away and start again.
        log(`Discarding the checkout of ${repoURL} and cloning from scratch`);
        try {
            await cloneRepo({ repoURL, repoPath: sourceRepoPath(repoURL), keyPath: sourceKeyPath(repoURL) });
            repoFailureCounts[repoURL] = 0;
            return true;
        } catch (cloneError) {
            log(`${repoURL} cannot be reached or cloned, its last known keys stay in place. ${cloneError}`);
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
            log(`Polling ${repoURL} failed. ${e && (e as Error).stack || e}`);
        }
    }
    if (anyChanged) {
        await saveState();
    }
    // The repo is checked first, so a change that came from it is reported as an update rather
    // than as somebody having edited the file locally.
    await enforceRootKeys({ keys: await readAllowedKeys(), reason: anyChanged && "repo" || "manual" });
    await checkOtherUserKeys();
    await enforceSSHDConfig();
}

function startInterval(config: { intervalTime: number; run: () => Promise<void>; name: string }) {
    let { intervalTime, run, name } = config;
    let running = false;
    let tick = async () => {
        if (running) {
            log(`Skipping ${name}, the previous run has not finished`);
            return;
        }
        running = true;
        try {
            await run();
        } catch (e) {
            // Every scheduled job swallows its own errors, the daemon must outlive any single one.
            log(`${name} failed. ${e && (e as Error).stack || e}`);
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

    log(`Starting, ${config.repoSources.length} source(s), keys applied to ${ROOT_AUTHORIZED_KEYS}`);

    // A first pass has to happen before the intervals, so a machine is correct immediately after
    // boot rather than a minute later.
    for (let repoURL of config.repoSources) {
        try {
            sourceState(repoURL).lastSha = (await syncRepo(repoURL)).remoteSha;
        } catch (e) {
            log(`Initial sync of ${repoURL} failed, continuing with whatever is on disk. ${e}`);
        }
    }
    await saveState();
    await seedUserKeys();

    await enforceRootKeys({ keys: await readAllowedKeys(), reason: "repo" });
    await enforceSSHDConfig();

    // configureDiscordNotifications watches the webhook file on its own, so there is nothing to
    // schedule for it here.
    startInterval({ name: "check", intervalTime: CHECK_INTERVAL, run: everyCheck });
}

process.on("uncaughtException", e => log(`Uncaught exception, staying up. ${e && e.stack || e}`));
process.on("unhandledRejection", e => log(`Unhandled rejection, staying up. ${e}`));
process.on("SIGTERM", () => {
    log("Received SIGTERM, exiting");
    process.exit(0);
});
