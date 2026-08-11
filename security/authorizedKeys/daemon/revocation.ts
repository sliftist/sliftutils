import fs from "fs/promises";
import path from "path";
import { keyFingerprint, summarizeKey } from "../authorizedKeys";
import { revokeRepoPath, revokeRepoURL } from "../revokeSource";
import { runGit } from "./git";
import { ensureRevokeKey, listRepoDir, readRepoFile, revokeRepo, sourceRepo, syncRepoFiles } from "./repoFiles";
import { messageTimestamp } from "../../notifications/discord";
import { UNREVOKE_DELAY } from "./paths";
import { addChangeReason } from "./changes";
import { describeAllEnded, endAllSSHSessions } from "./sessions";
import { getState, saveState } from "./state";

// One revocation per key, ever. Naming the file after the fingerprint is what makes that true:
// a second attempt from a different address lands on a name that already exists.
const REVOCATIONS_DIR = "revocations";
const UNREVOKES_DIR = "unrevoked";
const REVOCATION_REASON = "authenticated access from an unapproved IP";

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

/** Why a key stopped being accepted, in the words of whichever machine saw it happen. */
function describeRevocation(revocation: { revokedAt: string; revokedBy: string; reason: string; attemptIP: string }) {
    let when = Date.parse(revocation.revokedAt);
    let parts = [
        Number.isFinite(when) ? `revoked ${messageTimestamp(new Date(when))}` : `revoked at an unrecorded time`,
        revocation.revokedBy && `by \`${revocation.revokedBy}\`` || "",
        revocation.reason || "",
        revocation.attemptIP && `from \`${revocation.attemptIP}\`` || "",
    ];
    return parts.filter(part => part).join(", ");
}

export type RevocationFile = {
    fingerprint: string;
    revocationId: string;
    revokedAt: string;
    revokedBy: string;
    reason: string;
    attemptIP: string;
};

export async function readRevocationFiles(sourceURL: string): Promise<RevocationFile[]> {
    let repo = revokeRepo(sourceURL);
    let revocations: RevocationFile[] = [];
    for (let name of await listRepoDir(repo, REVOCATIONS_DIR)) {
        if (!name.endsWith(".json")) {
            continue;
        }
        try {
            let parsed = JSON.parse(await readRepoFile(repo, path.join(REVOCATIONS_DIR, name)) || "");
            if (parsed.fingerprint) {
                revocations.push({
                    fingerprint: parsed.fingerprint,
                    revocationId: parsed.revocationId || name.replace(/\.json$/, ""),
                    revokedAt: parsed.revokedAt || "",
                    revokedBy: parsed.revokedBy || "",
                    reason: parsed.reason || "",
                    attemptIP: parsed.attempt?.ip || "",
                });
            }
        } catch (e) {
            console.log(`Ignoring unreadable revocation ${name}. ${e}`);
        }
    }
    return revocations;
}

/** Unrevokes live in the source repo, so they are covered by its signature. Nothing is read out of
    them but which revocations they name: the times they state are written by whoever wrote the
    file, and a file that could set its own age could set it to an hour ago and skip the wait. */
export async function readUnrevokeIds(sourceURL: string) {
    let repo = sourceRepo(sourceURL);
    let ids = new Map<string, string>();
    for (let name of await listRepoDir(repo, UNREVOKES_DIR)) {
        if (!name.endsWith(".json")) {
            continue;
        }
        try {
            let parsed = JSON.parse(await readRepoFile(repo, path.join(UNREVOKES_DIR, name)) || "");
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
    try {
        await syncRepoFiles(revokeRepo(sourceURL));
    } catch (e) {
        console.error(`Cannot record the revocation of ${fingerprint}, ${revokeRepoURL(sourceURL)} could not be read. ${e}`);
        return false;
    }
    let revocationId = revocationIdOf(fingerprint);
    let existing = (await readRevocationFiles(sourceURL)).find(entry => entry.fingerprint === fingerprint);
    if (existing) {
        // Another machine got there first, which is the normal outcome when several see the same
        // attempt. Record it locally so we never look again.
        state.revocations[fingerprint] = {
            fingerprint, revocationId,
            revokedAt: existing.revokedAt, revokedBy: existing.revokedBy,
            reason: existing.reason, attemptIP: existing.attemptIP,
            unrevokeId: "", unrevoked: false,
            reportedRemoved: false,
        };
        await saveState();
        return false;
    }

    let repoPath = revokeRepoPath(sourceURL);
    let keyPath = await ensureRevokeKey(sourceURL);
    let directory = path.join(repoPath, REVOCATIONS_DIR);
    await fs.mkdir(directory, { recursive: true });
    let revokedAt = new Date().toISOString();
    await fs.writeFile(path.join(directory, `${revocationId}.json`), JSON.stringify({
        revocationId,
        fingerprint,
        key: keyLine,
        revokedAt,
        revokedBy: hostLabel,
        reason: REVOCATION_REASON,
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
        fingerprint, revocationId,
        revokedAt, revokedBy: hostLabel, reason: REVOCATION_REASON, attemptIP: attempt.ip,
        unrevokeId: "", unrevoked: false,
        // The message below already says this machine has stopped accepting the key, so the one
        // about noticing a revocation would only repeat it.
        reportedRemoved: true,
    };
    await saveState();
    let ended = describeAllEnded(await endAllSSHSessions());
    // Said when the file is written, not here, so one event produces one message.
    addChangeReason(
        `**AUTHENTICATED ACCESS FROM AN UNAPPROVED IP: \`${attempt.ip}\`** The key was correct, so`
        + ` either someone else has this key, or a developer's IP has changed.`
        + `\nkey \`${keyLine && summarizeKey(keyLine) || fingerprint}\` (\`${fingerprint}\`)`
        + `\ntried as user \`${attempt.user}\`, and is only allowed from \`${attempt.required}\``
        + `\nThat key is now revoked everywhere.${ended}`
        + `\nIf this really was an attack, IMMEDIATELY remove that key from \`${sourceURL}\`.`
        + `\nIf it was legitimate use, run this in \`${sourceURL}\`: \`yarn unrevoke git\``
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
        let entries;
        try {
            entries = await readRevocationFiles(sourceURL);
        } catch (e) {
            // Unreadable is not empty. Whatever we already knew stays exactly as it is.
            console.error(`Skipping the revocations of ${revokeRepoURL(sourceURL)}, they could not be read. ${e}`);
            continue;
        }
        for (let entry of entries) {
            if (state.revocations[entry.fingerprint]) {
                continue;
            }
            state.revocations[entry.fingerprint] = {
                fingerprint: entry.fingerprint,
                revocationId: entry.revocationId,
                revokedAt: entry.revokedAt,
                revokedBy: entry.revokedBy,
                reason: entry.reason,
                attemptIP: entry.attemptIP,
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
    cannot instantly undo the revocation that shut it out.

    The hour is counted from when this machine first saw the unrevoke, and that moment is written
    to disk. Revocations themselves are held in memory, so a restart forgets them and reads them
    back out of the repo - if the wait were kept alongside them it would start again on every
    restart, and a machine that restarts would never let an unrevoke through. */
export async function applyUnrevokes(sourceURLs: string[]) {
    let state = getState();
    let unrevokeIds = new Map<string, string>();
    for (let sourceURL of sourceURLs) {
        try {
            for (let [revocationId, unrevokeId] of await readUnrevokeIds(sourceURL)) {
                unrevokeIds.set(revocationId, unrevokeId);
            }
        } catch (e) {
            // Unreadable is not "there are no unrevokes". The revocations simply stand.
            console.error(`Skipping the unrevokes of ${sourceURL}, they could not be read. ${e}`);
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
        let firstSeen = state.unrevokeFirstSeen[unrevokeId];
        if (!firstSeen) {
            firstSeen = Date.now();
            state.unrevokeFirstSeen[unrevokeId] = firstSeen;
            revocation.unrevokeId = unrevokeId;
            await saveState();
        }
        if (Date.now() - firstSeen < UNREVOKE_DELAY) {
            // Nothing has changed yet, so nobody is told. Whoever published it was already told it
            // takes an hour, and every machine seeing the same unrevoke would say so separately.
            console.log(
                `Holding the unrevoke ${unrevokeId} for ${revocation.fingerprint} until`
                + ` ${messageTimestamp(new Date(firstSeen + UNREVOKE_DELAY))}`
            );
            continue;
        }
        revocation.unrevoked = true;
        revocation.reportedRemoved = false;
        await saveState();
        // Only means anything if the key comes back into the file, so it is said there.
        addChangeReason(`the unrevoke of \`${revocation.fingerprint}\` has taken effect, ${unrevokeId}.`);
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
    let dropped: string[] = [];
    for (let key of keys) {
        let fingerprint = keyFingerprint(key);
        if (!fingerprint || !revoked.has(fingerprint)) {
            allowed.push(key);
            continue;
        }
        dropped.push(fingerprint);
        let revocation = state.revocations[fingerprint];
        if (!revocation || revocation.reportedRemoved) {
            continue;
        }
        revocation.reportedRemoved = true;
        await saveState();
        // Nothing to do if the key is not in the file. It left long ago, and this is a machine that
        // restarted and read the revocation back out of the repo.
        if (!state.appliedKeys.includes(key)) {
            continue;
        }
        // Whatever that key is holding open goes with it.
        let ended = describeAllEnded(await endAllSSHSessions());
        addChangeReason(
            `a revocation published elsewhere for \`${fingerprint}\`,`
            + ` ${describeRevocation(revocation)}.${ended}`
        );
    }
    // Said on every check, not once. A key being held out of authorized_keys is the current state
    // of the machine, and someone reading the log to work out why a key does not work should find
    // the answer there rather than having to know what to search the history for.
    if (dropped.length) {
        console.log(
            `Dropped ${dropped.length} revoked key(s) from the merged set, ${allowed.length} left.`
            + ` Revoked: ${dropped.join(", ")}`
        );
    }
    return allowed;
}
