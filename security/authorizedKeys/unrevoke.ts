import fs from "fs/promises";
import os from "os";
import path from "path";
import { keyFingerprint, normalizeKeys } from "./authorizedKeys";
import { deriveRevokeKey, revokeRepoURL } from "./revokeSource";
import { findSourceKey } from "./sources";
import { spawnPromise } from "../helpers/spawn";

export const UNREVOKES_DIR = "unrevoked";
const REVOCATIONS_DIR = "revocations";

/** One revocation event. Either an ssh key used from an address it is not allowed from, or a
    machine that talked to us from one. Both are the same shape - an identity and an address - and
    an unrevoke undoes either by allowing that same pair.

    Which is why unrevoking never makes anything unrevokable: used from some other address, it is
    revoked again, under a new id no existing unrevoke names. */
export type Revocation = {
    revocationId: string;
    // Exactly one of these. A key revocation names a fingerprint, a machine revocation a machineId.
    fingerprint?: string;
    machineId?: string;
    ip?: string;
    key?: string;
    revokedAt?: string;
    revokedBy?: string;
    reason?: string;
    attempt?: { ip?: string; user?: string; required?: string };
};

/** Older revocation files carry the address under attempt only. */
export function revocationIP(revocation: Revocation) {
    return revocation.ip || revocation.attempt?.ip || "";
}

/** What the revocation is about, which is what an unrevoke has to name to undo it. */
export function revocationIdentity(revocation: Revocation) {
    return revocation.fingerprint || revocation.machineId || "";
}

/** Every revocation the revoke repo lists. Cloned read only into a temp directory.

    A person running this has their own access to the repo, so their credentials are what is used.
    On a machine that is already a portsecure host there may be no such credentials, but the source
    deploy key is right there, and the key derived from it is one that repo definitely accepts. */
export async function readRemoteRevocations(config: { sourceURL: string }) {
    let { sourceURL } = config;
    let temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "unrevoke-"));
    let repoPath = path.join(temporaryDirectory, "repo");
    let cloneArgs = ["clone", "--depth", "1", revokeRepoURL(sourceURL), repoPath];
    let sourceKey = await findSourceKey(sourceURL);
    if (sourceKey) {
        let derived = deriveRevokeKey(await fs.readFile(sourceKey, "utf8"));
        let derivedKeyPath = path.join(temporaryDirectory, "key");
        await fs.writeFile(derivedKeyPath, derived.privateKeyFile, { mode: 0o600 });
        let sshCommand = `ssh -i ${derivedKeyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
        cloneArgs = ["-c", `core.sshCommand=${sshCommand}`, ...cloneArgs];
    }
    let clone = await spawnPromise({ command: "git", args: cloneArgs });
    if (clone.status !== 0) {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
        throw new Error(
            `Expected to be able to read ${revokeRepoURL(sourceURL)}.\n`
            + `${(clone.stdout + clone.stderr).trim()}`
        );
    }
    let revocations: Revocation[] = [];
    let directory = path.join(repoPath, REVOCATIONS_DIR);
    try {
        for (let name of (await fs.readdir(directory)).sort()) {
            if (name.endsWith(".json")) {
                revocations.push(JSON.parse(await fs.readFile(path.join(directory, name), "utf8")));
            }
        }
    } catch (e) {
        // No revocations directory at all just means nothing has ever been revoked.
    }
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    return revocations;
}

/** What the unrevokes already in a repo allow: "<identity> <address>" for each pair, plus the bare
    revocation ids the older format named.

    Read out of the repo rather than out of the daemon's absorbed state, because whoever runs a cli
    is looking at a checkout and has no daemon in the process to ask. */
export async function readUnrevokedInRepo(repoPath: string) {
    let unrevoked = new Set<string>();
    try {
        let directory = path.join(repoPath, UNREVOKES_DIR);
        for (let name of await fs.readdir(directory)) {
            if (!name.endsWith(".json")) {
                continue;
            }
            let parsed = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
            for (let allowed of parsed.allowed || []) {
                let identity = allowed.fingerprint || allowed.machineId;
                if (identity && allowed.ip) {
                    unrevoked.add(`${identity} ${allowed.ip}`);
                }
            }
            // Named ids, for the unrevokes written before this was about pairs.
            for (let revocationId of parsed.revocationIds || []) {
                unrevoked.add(revocationId);
            }
        }
    } catch (e) {
        // Nothing has been unrevoked.
    }
    return unrevoked;
}

/** The revocations those unrevokes have not already undone.

    Matched on revocationIdentity, not on fingerprint: a machine revocation carries a machineId and
    no fingerprint, so comparing fingerprints leaves every machine looking revoked forever no matter
    how many times it is unrevoked. */
export function stillRevokedBy(revocations: Revocation[], unrevoked: Set<string>) {
    return revocations.filter(revocation =>
        !unrevoked.has(revocation.revocationId)
        && !unrevoked.has(`${revocationIdentity(revocation)} ${revocationIP(revocation)}`)
    );
}

/** Which keys in a repo are revoked. What signfiles and securessh refuse over. */
export async function revokedKeysInRepo(config: { repoPath: string; sourceURL: string }) {
    let { repoPath, sourceURL } = config;
    let revocations = await readRemoteRevocations({ sourceURL });
    let unrevoked = await readUnrevokedInRepo(repoPath);
    let stillRevoked = stillRevokedBy(revocations, unrevoked);
    let keys = normalizeKeys(await fs.readFile(path.join(repoPath, "authorized_keys"), "utf8").catch(() => ""));
    return stillRevoked
        .filter(revocation => keys.some(key => keyFingerprint(key) === revocation.fingerprint))
        .map(revocation => ({ revocation, key: keys.find(key => keyFingerprint(key) === revocation.fingerprint) || "" }));
}
