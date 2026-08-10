import fs from "fs/promises";
import path from "path";
import { keyFingerprint, summarizeKey } from "../authorizedKeys";
import { deriveRevokeKey, revokeKeyPath, revokeRepoPath, revokeRepoURL } from "../revokeSource";
import { sourceKeyPath, sourceRepoPath } from "../sources";
import { cloneRepo, repoIsUsable, runGit } from "./git";
import { messageTimestamp } from "../../notifications/discord";
import { UNREVOKE_DELAY } from "./paths";
import { notify } from "./notify";
import { describeEndedSessions, endSessionsUsingKey } from "./sessions";
import { getState, saveState } from "./state";

// One revocation per key, ever. Naming the file after the fingerprint is what makes that true:
// a second attempt from a different address lands on a name that already exists.
const REVOCATIONS_DIR = "revocations";
const UNREVOKES_DIR = "unrevoked";

export type Attempt = {
    ip: string;
    user: string;
    port: string;
    required: string;
    line: string;
};

export function revocationIdOf(fingerprint: string) {
    return fingerprint.replace(/^SHA256:/, "").replace(/[^A-Za-z0-9]+/g, "-");
}

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

/** The revoke repo's key is worked out from the source's, so nothing extra had to be uploaded and
    nothing extra is stored anywhere it could be taken from. */
async function ensureRevokeKey(sourceURL: string) {
    let keyPath = revokeKeyPath(sourceURL);
    if (await pathExists(keyPath)) {
        return keyPath;
    }
    let derived = deriveRevokeKey(await fs.readFile(sourceKeyPath(sourceURL), "utf8"));
    await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(keyPath, derived.privateKeyFile, { mode: 0o600 });
    console.log(`Derived the revoke key for ${sourceURL}`);
    return keyPath;
}

/** Brings the revoke checkout up to date. Returns false when it cannot be reached, so a missing
    revoke repo degrades to "keep what we already know" rather than stopping everything. */
export async function syncRevokeRepo(sourceURL: string) {
    let repoURL = revokeRepoURL(sourceURL);
    let repoPath = revokeRepoPath(sourceURL);
    let keyPath = await ensureRevokeKey(sourceURL);
    try {
        if (!await repoIsUsable({ repoPath, keyPath })) {
            await cloneRepo({ repoURL, repoPath, keyPath });
            return true;
        }
        let localHead = await runGit({ args: ["rev-parse", "HEAD"], cwd: repoPath, keyPath, allowFailure: true });
        if (localHead.status !== 0) {
            // A revoke repo with no commits yet. Nothing has ever been revoked, which is the state
            // every one of these starts in, so there is nothing to pull and nothing to say.
            return true;
        }
        let head = (await runGit({ args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: repoPath, keyPath })).stdout.trim();
        let localSha = localHead.stdout.trim();
        // A ref listing is a few hundred bytes and no objects, so the usual case of nothing having
        // been revoked anywhere costs almost nothing.
        let listing = (await runGit({ args: ["ls-remote", "origin", head], cwd: repoPath, keyPath })).stdout;
        let remoteSha = (listing.split(/\s+/)[0] || "").trim();
        if (remoteSha && remoteSha === localSha) {
            return true;
        }
        await runGit({ args: ["fetch", "--prune", "origin"], cwd: repoPath, keyPath });
        await runGit({ args: ["reset", "--hard", `origin/${head}`], cwd: repoPath, keyPath });
        await runGit({ args: ["clean", "-fdx"], cwd: repoPath, keyPath });
        return true;
    } catch (e) {
        console.log(`Could not sync ${repoURL}. ${e}`);
        return false;
    }
}

export async function readRevocationFiles(sourceURL: string) {
    let directory = path.join(revokeRepoPath(sourceURL), REVOCATIONS_DIR);
    if (!await pathExists(directory)) {
        return [];
    }
    let revocations: { fingerprint: string; revocationId: string }[] = [];
    for (let name of (await fs.readdir(directory)).sort()) {
        if (!name.endsWith(".json")) {
            continue;
        }
        try {
            let parsed = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
            if (parsed.fingerprint) {
                revocations.push({ fingerprint: parsed.fingerprint, revocationId: parsed.revocationId || name.replace(/\.json$/, "") });
            }
        } catch (e) {
            console.log(`Ignoring unreadable revocation ${name}. ${e}`);
        }
    }
    return revocations;
}

/** Unrevokes live in the source repo, so they are covered by its signature. */
export async function readUnrevokeIds(sourceURL: string) {
    let directory = path.join(sourceRepoPath(sourceURL), UNREVOKES_DIR);
    if (!await pathExists(directory)) {
        return new Map<string, string>();
    }
    let ids = new Map<string, string>();
    for (let name of (await fs.readdir(directory)).sort()) {
        if (!name.endsWith(".json")) {
            continue;
        }
        try {
            let parsed = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
            for (let revocationId of parsed.revocationIds || []) {
                ids.set(revocationId, name.replace(/\.json$/, ""));
            }
        } catch (e) {
            console.log(`Ignoring unreadable unrevoke ${name}. ${e}`);
        }
    }
    return ids;
}

/** Writes a revocation, unless this key is already revoked. Checked twice: against what this
    machine already knows, which needs no network, and again against the repo after pulling it,
    so a flood of unknown keys cannot turn into a flood of commits. */
export async function recordRevocation(config: {
    sourceURL: string;
    fingerprint: string;
    keyLine: string;
    attempt: Attempt;
    hostLabel: string;
}) {
    let { sourceURL, fingerprint, keyLine, attempt, hostLabel } = config;
    let state = getState();
    if (state.revocations[fingerprint]) {
        return false;
    }
    if (!await syncRevokeRepo(sourceURL)) {
        console.log(`Cannot record the revocation of ${fingerprint}, ${revokeRepoURL(sourceURL)} is unreachable`);
        return false;
    }
    let revocationId = revocationIdOf(fingerprint);
    let alreadyThere = (await readRevocationFiles(sourceURL)).some(entry => entry.fingerprint === fingerprint);
    if (alreadyThere) {
        // Another machine got there first, which is the normal outcome when several see the same
        // attempt. Record it locally so we never look again.
        state.revocations[fingerprint] = {
            fingerprint, revocationId, unrevokeSeenAt: 0, unrevokeId: "", unrevoked: false,
            reportedRemoved: false,
        };
        await saveState();
        return false;
    }

    let repoPath = revokeRepoPath(sourceURL);
    let keyPath = revokeKeyPath(sourceURL);
    let directory = path.join(repoPath, REVOCATIONS_DIR);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${revocationId}.json`), JSON.stringify({
        revocationId,
        fingerprint,
        key: keyLine,
        revokedAt: new Date().toISOString(),
        revokedBy: hostLabel,
        reason: "used from an address its from= restriction does not allow",
        attempt,
    }, undefined, 4) + "\n");

    await runGit({ args: ["add", "-A"], cwd: repoPath, keyPath });
    await runGit({ args: ["-c", "user.email=portsecure@localhost", "-c", "user.name=portsecure", "commit", "-m", `revoke ${revocationId}`], cwd: repoPath, keyPath });
    let push = await runGit({ args: ["push", "origin", "HEAD"], cwd: repoPath, keyPath, allowFailure: true });
    if (push.status !== 0) {
        // Most likely another machine pushed the same revocation first. The next check will pull
        // it and record it, so there is nothing to retry here.
        console.log(`Could not push the revocation of ${fingerprint}, will pick it up on the next check. ${(push.stdout + push.stderr).trim()}`);
        return false;
    }
    state.revocations[fingerprint] = {
        fingerprint, revocationId, unrevokeSeenAt: 0, unrevokeId: "", unrevoked: false,
        // The message below already says this machine has stopped accepting the key, so the one
        // about noticing a revocation would only repeat it.
        reportedRemoved: true,
    };
    await saveState();
    // Killed before saying anything, so the message reports what was actually done rather than
    // what was about to be attempted.
    let ended = describeEndedSessions(await endSessionsUsingKey(fingerprint));
    // What happened, then what was done about it, then what to do about it. In that order, because
    // whoever reads this needs to know which of those two things it was before anything else.
    await notify(
        `**AUTHENTICATED ACCESS FROM AN UNAPPROVED IP.** The key was correct, so either someone`
        + ` else has this key, or a developer's IP has changed.`
        + `\nkey \`${keyLine && summarizeKey(keyLine) || fingerprint}\` (\`${fingerprint}\`)`
        + `\ntried from \`${attempt.ip}\` as user \`${attempt.user}\``
        + `\nonly allowed from \`${attempt.required}\``
        + `\n\nThat key is now revoked. Every machine will remove it from root's authorized_keys and`
        + ` stop accepting it, from any address.${ended}`
        + `\n\nIf this really was an attack, IMMEDIATELY remove that key from \`${sourceURL}\`.`
        + `\nIf it was legitimate use, run this in \`${sourceURL}\` and deploy it as normal:`
        + `\n\`\`\`\nyarn unrevoke\nyarn signfiles git\n\`\`\``
    );
    return true;
}

/** Takes everything the revoke repos list into local state. Once here a revocation never leaves,
    even if the file is deleted: the key that writes revocations is on every server, so an attacker
    holding it could otherwise erase the record that locked them out. */
export async function absorbRevocations(sourceURLs: string[]) {
    let state = getState();
    let changed = false;
    for (let sourceURL of sourceURLs) {
        for (let entry of await readRevocationFiles(sourceURL)) {
            if (state.revocations[entry.fingerprint]) {
                continue;
            }
            state.revocations[entry.fingerprint] = {
                fingerprint: entry.fingerprint,
                revocationId: entry.revocationId,
                unrevokeSeenAt: 0,
                unrevokeId: "",
                unrevoked: false,
                reportedRemoved: false,
            };
            changed = true;
        }
    }
    if (changed) {
        await saveState();
    }
}

/** An unrevoke is held for an hour before it counts, so a signing key that was itself compromised
    cannot instantly undo the revocation that shut it out. */
export async function applyUnrevokes(sourceURLs: string[]) {
    let state = getState();
    let unrevokeIds = new Map<string, string>();
    for (let sourceURL of sourceURLs) {
        for (let [revocationId, unrevokeId] of await readUnrevokeIds(sourceURL)) {
            unrevokeIds.set(revocationId, unrevokeId);
        }
    }
    for (let revocation of Object.values(state.revocations)) {
        if (revocation.unrevoked) {
            continue;
        }
        let unrevokeId = unrevokeIds.get(revocation.revocationId);
        if (!unrevokeId) {
            continue;
        }
        if (!revocation.unrevokeSeenAt) {
            revocation.unrevokeSeenAt = Date.now();
            revocation.unrevokeId = unrevokeId;
            await saveState();
            await notify(
                `an unrevoke for \`${revocation.fingerprint}\` was published as \`${unrevokeId}\`.`
                + ` It will NOT be applied now. That key starts working again at`
                + ` \`${messageTimestamp(new Date(revocation.unrevokeSeenAt + UNREVOKE_DELAY))}\`.`
            );
            continue;
        }
        if (Date.now() - revocation.unrevokeSeenAt < UNREVOKE_DELAY) {
            continue;
        }
        revocation.unrevoked = true;
        revocation.reportedRemoved = false;
        await saveState();
        await notify(
            `the unrevoke of \`${revocation.fingerprint}\` has been applied. The key is accepted again`
            + ` if it is still in a keys repo.`
        );
    }
}

export function revokedFingerprints() {
    return new Set(
        Object.values(getState().revocations)
            .filter(revocation => !revocation.unrevoked)
            .map(revocation => revocation.fingerprint)
    );
}

/** Drops revoked keys from the merged set, and says so the first time a key actually disappears -
    which is the thing worth knowing, rather than the mere existence of a revocation. */
export async function removeRevokedKeys(keys: string[]) {
    let revoked = revokedFingerprints();
    if (!revoked.size) {
        return keys;
    }
    let state = getState();
    let allowed: string[] = [];
    for (let key of keys) {
        let fingerprint = keyFingerprint(key);
        if (!fingerprint || !revoked.has(fingerprint)) {
            allowed.push(key);
            continue;
        }
        // Said once, when the key actually goes, and only on a machine that is learning about the
        // revocation from the repo. The machine that did the revoking already said so itself.
        let revocation = state.revocations[fingerprint];
        if (revocation && !revocation.reportedRemoved) {
            revocation.reportedRemoved = true;
            await saveState();
            // A machine learning of a revocation from the repo has its own sessions to end.
            let ended = describeEndedSessions(await endSessionsUsingKey(fingerprint));
            await notify(
                `observed a revocation in the revoke repo for \`${fingerprint}\`, and removed that key`
                + ` from root's authorized_keys. This machine no longer accepts it.${ended}`
            );
        }
    }
    return allowed;
}
