import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { keyFingerprint, keyNiceName, summarizeKey } from "../authorizedKeys";
import { revokeRepoPath, revokeRepoURL } from "../revokeSource";
import { sourceRepoPath } from "../sources";
import { runGit } from "./git";
import { ensureRevokeKey, listRepoDir, readRepoFile, revokeRepo, sourceRepo, syncRepoFiles } from "./repoFiles";
import { messageTimestamp } from "../../notifications/discord";
import { addChangeReason, addLeadingChangeReason } from "./changes";
import { describeAllEnded, endAllSSHSessions } from "./sessions";
import { getState, saveState } from "./state";

// A revocation says: this key, used from this address, is no longer accepted. An unrevoke says the
// opposite about one pair: this key is allowed from this address. They cancel out when both halves
// match, which is why a revocation is one event with an id of its own, and never a name derived
// from the key - forgiving a key for one address must not make it unrevokable everywhere.
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

/** What an unrevoke has to name to undo a revocation, and what stops a second revocation of the
    same key from the same address. */
export function pairKey(config: { fingerprint: string; ip: string }) {
    return `${config.fingerprint} ${config.ip}`;
}

/** Unique to the event. The time is there to read, the random half is there to be unique. */
export function newRevocationId(fingerprint: string) {
    let stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `${stamp}-${randomBytes(8).toString("hex")}-${fingerprint.replace(/^SHA256:/, "").slice(0, 8).replace(/[^A-Za-z0-9]+/g, "")}`;
}

/** Why a key stopped being accepted, in the words of whichever machine saw it happen. */
function describeRevocation(revocation: { revokedAt: string; revokedBy: string; reason: string; ip: string }) {
    let when = Date.parse(revocation.revokedAt);
    let parts = [
        Number.isFinite(when) ? `revoked ${messageTimestamp(new Date(when))}` : `revoked at an unrecorded time`,
        revocation.revokedBy && `by \`${revocation.revokedBy}\`` || "",
        revocation.reason || "",
        revocation.ip && `from \`${revocation.ip}\`` || "",
    ];
    return parts.filter(part => part).join(", ");
}

export type RevocationFile = {
    revocationId: string;
    fingerprint: string;
    ip: string;
    revokedAt: string;
    revokedBy: string;
    reason: string;
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
                    revocationId: parsed.revocationId || name.replace(/\.json$/, ""),
                    fingerprint: parsed.fingerprint,
                    ip: parsed.ip || parsed.attempt?.ip || "",
                    revokedAt: parsed.revokedAt || "",
                    revokedBy: parsed.revokedBy || "",
                    reason: parsed.reason || "",
                });
            }
        } catch (e) {
            console.log(`Ignoring unreadable revocation ${name}. ${e}`);
        }
    }
    return revocations;
}

/** Which key is allowed from which address. Unrevokes live in the source repo, so they are covered
    by its signature, and nothing is read out of them but the pairs they allow and, for files
    written before pairs existed, the revocation ids they name. */
export type Unrevokes = {
    // fingerprint and ip, to every unrevoke that allows them. Every one rather than the last,
    // because the same pair is often named again by a later unrevoke and there is no reason to
    // prefer one over another.
    pairs: Map<string, string[]>;
    // Revocation id to the unrevokes naming it. Only for unrevokes written before this was about
    // pairs at all, so a machine reading one already in a repo still honours it.
    legacyIds: Map<string, string[]>;
};

export async function readUnrevokes(sourceURL: string): Promise<Unrevokes> {
    let repo = sourceRepo(sourceURL);
    let pairs = new Map<string, string[]>();
    let legacyIds = new Map<string, string[]>();
    let add = (into: Map<string, string[]>, key: string, unrevokeId: string) => {
        into.set(key, [...(into.get(key) || []), unrevokeId]);
    };
    for (let name of await listRepoDir(repo, UNREVOKES_DIR)) {
        if (!name.endsWith(".json")) {
            continue;
        }
        let unrevokeId = name.replace(/\.json$/, "");
        try {
            let parsed = JSON.parse(await readRepoFile(repo, path.join(UNREVOKES_DIR, name)) || "");
            for (let allowed of parsed.allowed || []) {
                // Either kind of identity: an ssh key names a fingerprint, a machine a machineId.
                let identity = allowed.fingerprint || allowed.machineId;
                if (identity && allowed.ip) {
                    add(pairs, pairKey({ fingerprint: identity, ip: allowed.ip }), unrevokeId);
                }
            }
            for (let revocationId of parsed.revocationIds || []) {
                add(legacyIds, revocationId, unrevokeId);
            }
        } catch (e) {
            console.log(`Ignoring unreadable unrevoke ${name}. ${e}`);
        }
    }
    return { pairs, legacyIds };
}

/** Every unrevoke covering one revocation: by the pair it is about, and by its id for the files
    written before pairs existed. */
export function unrevokesFor(unrevokes: Unrevokes, revocation: { revocationId: string; fingerprint: string; ip: string }) {
    return [
        ...unrevokes.pairs.get(pairKey(revocation)) || [],
        ...unrevokes.legacyIds.get(revocation.revocationId) || [],
    ];
}

/** Writes a revocation, unless this key is already revoked for this address. Checked twice:
    against what this machine already knows, which needs no network, and again against the repo
    after pulling it, so a flood of unknown keys cannot turn into a flood of commits.

    Deduplication is on the pair. The same key from a second address is a second event and gets its
    own revocation, because an unrevoke only ever forgives the pair it names. */
export async function recordRevocation(config: {
    sourceURL: string;
    fingerprint: string;
    keyLine: string;
    attempt: Attempt;
    hostLabel: string;
}) {
    let { sourceURL, fingerprint, keyLine, attempt, hostLabel } = config;
    let state = getState();
    let pair = pairKey({ fingerprint, ip: attempt.ip });
    if (Object.values(state.revocations).some(entry => pairKey(entry) === pair)) {
        return false;
    }
    try {
        await syncRepoFiles(revokeRepo(sourceURL));
    } catch (e) {
        console.error(`Cannot record the revocation of ${fingerprint}, ${revokeRepoURL(sourceURL)} could not be read. ${e}`);
        return false;
    }
    let revocationId = newRevocationId(fingerprint);
    let existing = (await readRevocationFiles(sourceURL)).find(entry => pairKey(entry) === pair);
    if (existing) {
        // Another machine got there first, which is the normal outcome when several see the same
        // attempt. Record it locally so we never look again.
        state.revocations[existing.revocationId] = {
            revocationId: existing.revocationId,
            fingerprint: existing.fingerprint, ip: existing.ip,
            revokedAt: existing.revokedAt, revokedBy: existing.revokedBy,
            reason: existing.reason,
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
        // The two halves of what happened. An unrevoke naming both is what undoes this.
        ip: attempt.ip,
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
    state.revocations[revocationId] = {
        revocationId, fingerprint, ip: attempt.ip,
        revokedAt, revokedBy: hostLabel, reason: REVOCATION_REASON,
        unrevokeId: "", unrevoked: false,
        // The message below already says this machine has stopped accepting the key, so the one
        // about noticing a revocation would only repeat it.
        reportedRemoved: true,
    };
    await saveState();
    let ended = describeAllEnded(await endAllSSHSessions());
    // Said when the file is written, not here, so one event produces one message.
    addLeadingChangeReason({
        headline: `SUSPICIOUS IP ${attempt.ip} FROZE KEY ${keyLine && keyNiceName(keyLine) || fingerprint}`,
        body:
            `Someone logged in from ${attempt.ip} using a key that is not allowed from there. The`
            + ` key itself was correct, so either someone else has a copy of it, or one of your own`
            + ` addresses changed.`
            + `\n\nThe key is frozen on every machine now, and works nowhere.${ended}`
            + `\n\nIf this was an attack, remove that key from \`${sourceURL}\` now.`
            + `\nIf it was you, run:`
            + `\n\`\`\`\ncd ${sourceRepoPath(sourceURL)}\nyarn unrevoke git\n\`\`\``
            + `\nIt allows ${attempt.ip} on that key, and takes an hour to reach every machine.`
            + `\n\nkey: \`${keyLine && summarizeKey(keyLine) || fingerprint}\``
            + `\ntried to log in as: \`${attempt.user}\``
            + `\nallowed only from: \`${attempt.required}\``,
    });
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
            if (state.revocations[entry.revocationId]) {
                continue;
            }
            state.revocations[entry.revocationId] = {
                revocationId: entry.revocationId,
                fingerprint: entry.fingerprint,
                ip: entry.ip,
                revokedAt: entry.revokedAt,
                revokedBy: entry.revokedBy,
                reason: entry.reason,
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

/** An unrevoke counts the moment it is seen.

    There used to be an hour's wait before honouring one, against a signing key that had itself
    been stolen. It was never worth it: an unrevoke has to be signed, so writing one already takes
    the hardware key, and anyone holding that can sign a new authorized_keys naming whatever they
    like - they have no reason to go near an unrevoke. Meanwhile the wait cost real access, and a
    machine deployed after an incident would freeze keys it had never had a problem with, for an
    hour, because it was seeing the unrevoke for the first time.

    What still protects a stolen signing key is the 24 hours before a NEW signer is accepted. */
export async function applyUnrevokes(sourceURLs: string[]) {
    let state = getState();
    let unrevokes: Unrevokes = { pairs: new Map(), legacyIds: new Map() };
    for (let sourceURL of sourceURLs) {
        try {
            let source = await readUnrevokes(sourceURL);
            for (let [pair, ids] of source.pairs) {
                unrevokes.pairs.set(pair, [...(unrevokes.pairs.get(pair) || []), ...ids]);
            }
            for (let [revocationId, ids] of source.legacyIds) {
                unrevokes.legacyIds.set(revocationId, [...(unrevokes.legacyIds.get(revocationId) || []), ...ids]);
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
        let covering = unrevokesFor(unrevokes, revocation);
        if (!covering.length) {
            continue;
        }
        let unrevokeId = covering[0];
        revocation.unrevokeId = unrevokeId;
        revocation.unrevoked = true;
        revocation.reportedRemoved = false;
        await saveState();
        // Only means anything if the key comes back into the file, so it is said there.
        addChangeReason(
            `Unfroze a key for \`${revocation.ip}\`. It was frozen for being used from there, and`
            + ` ${unrevokeId} says that address is allowed after all.`
        );
    }
}

/** Reports each revocation the first time it actually takes a key out of this machine's file. The
    dropping itself happens in readSignedRepo, which strips revoked keys before anything reads them
    - this only says so, and kills whatever sessions the key was holding open. */
export async function reportRevokedKeys() {
    let state = getState();
    for (let revocation of Object.values(state.revocations)) {
        if (revocation.unrevoked || revocation.reportedRemoved) {
            continue;
        }
        revocation.reportedRemoved = true;
        await saveState();
        // Nothing to do if the key is not in the file. It left long ago, and this is a machine that
        // restarted and read the revocation back out of the repo.
        let key = state.appliedKeys.find(applied => keyFingerprint(applied) === revocation.fingerprint);
        if (!key) {
            continue;
        }
        // Whatever that key is holding open goes with it.
        let ended = describeAllEnded(await endAllSSHSessions());
        addLeadingChangeReason({
            headline: `SUSPICIOUS IP ${revocation.ip || "unknown"} FROZE KEY ${keyNiceName(key)}`,
            body:
                `Another machine saw this key used from an address it is not allowed from, and`
                + ` froze it everywhere. This machine has stopped accepting it too.${ended}`
                + `\n\nkey: \`${summarizeKey(key)}\``
                + `\n${describeRevocation(revocation)}`,
        });
    }
}
