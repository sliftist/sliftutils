import fs from "fs/promises";
import os from "os";
import path from "path";
import { runPromise } from "socket-function/src/runPromise";
import { allowAddresses, keyFingerprint, normalizeKeys, summarizeKey } from "./authorizedKeys";
import { deriveRevokeKey, revokeRepoURL } from "./revokeSource";
import { findSourceKey } from "./sources";
import { signRepo } from "../signedFiles/signFiles";
import { readRepoKeys } from "./authorizedKeys";
import { expandHome } from "../helpers/paths";
import { spawnPromise } from "../helpers/spawn";

const UNREVOKES_DIR = "unrevoked";
const REVOCATIONS_DIR = "revocations";
const GIT_KEYWORD = "git";
const COMMIT_MESSAGE = "unrevoke keys";
const USAGE = `Usage: yarn unrevoke [keys-repo] [${GIT_KEYWORD}]

Run this in a keys repo, or name one. It reads that repo's revoke repo and writes one unrevoke file
naming every revocation in it, so the keys are accepted again once each machine's hour long wait
passes. It signs the result, and with ${GIT_KEYWORD} it commits and pushes it too.

Keys that were revoked should normally be deleted from the repo instead. Unrevoking only matters
for a key you still want.`;

export type Revocation = {
    revocationId: string;
    fingerprint: string;
    // The address the key was used from. A revocation is about this pair, and an unrevoke undoes
    // it by allowing that same pair - which is why unrevoking never makes a key unrevokable: used
    // from some other address, it is revoked again.
    ip?: string;
    key?: string;
    revokedAt?: string;
    revokedBy?: string;
    attempt?: { ip?: string; user?: string; required?: string };
};

/** Older revocation files carry the address under attempt only. */
export function revocationIP(revocation: Revocation) {
    return revocation.ip || revocation.attempt?.ip || "";
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

/** Which keys in a repo are revoked. What signfiles and securessh refuse over. */
export async function revokedKeysInRepo(config: { repoPath: string; sourceURL: string }) {
    let { repoPath, sourceURL } = config;
    let revocations = await readRemoteRevocations({ sourceURL });
    let revokedFingerprints = new Set(revocations.map(revocation => revocation.fingerprint));
    let unrevoked = new Set<string>();
    try {
        let directory = path.join(repoPath, UNREVOKES_DIR);
        for (let name of await fs.readdir(directory)) {
            if (!name.endsWith(".json")) {
                continue;
            }
            let parsed = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
            for (let allowed of parsed.allowed || []) {
                unrevoked.add(`${allowed.fingerprint} ${allowed.ip}`);
            }
            // Named ids, for the unrevokes written before this was about pairs.
            for (let revocationId of parsed.revocationIds || []) {
                unrevoked.add(revocationId);
            }
        }
    } catch (e) {
        // Nothing has been unrevoked.
    }
    let stillRevoked = revocations.filter(revocation => !unrevoked.has(revocation.revocationId)
        && !unrevoked.has(`${revocation.fingerprint} ${revocationIP(revocation)}`));
    let keys = normalizeKeys(await fs.readFile(path.join(repoPath, "authorized_keys"), "utf8").catch(() => ""));
    return stillRevoked
        .filter(revocation => keys.some(key => keyFingerprint(key) === revocation.fingerprint))
        .map(revocation => ({ revocation, key: keys.find(key => keyFingerprint(key) === revocation.fingerprint) || "" }));
}

/** Writes the addresses into the from= list of each key in the repo's authorized_keys, and says
    which ones were actually new. Only the lines being changed are touched, so comments, ordering
    and any key not involved come out of this byte for byte the same. */
async function allowAddressesInRepo(config: {
    repoPath: string;
    addressesByFingerprint: Map<string, string[]>;
}) {
    let { repoPath, addressesByFingerprint } = config;
    let added = new Map<string, string[]>();
    let filePath = path.join(repoPath, "authorized_keys");
    let contents;
    try {
        contents = await fs.readFile(filePath, "utf8");
    } catch (e) {
        // A repo holding its keys as separate .pub files. Nothing to edit in one place, so the
        // caller's listing is all whoever ran this gets.
        console.log(`No authorized_keys in ${repoPath}, so the addresses were not added to any key.`);
        return added;
    }
    let lines = contents.split("\n");
    for (let index = 0; index < lines.length; index++) {
        let fingerprint = keyFingerprint(lines[index]);
        let addresses = fingerprint && addressesByFingerprint.get(fingerprint);
        if (!addresses || !addresses.length) {
            continue;
        }
        let result = allowAddresses(lines[index], addresses);
        lines[index] = result.keyLine;
        added.set(fingerprint, [...(added.get(fingerprint) || []), ...result.added]);
    }
    if ([...added.values()].some(list => list.length)) {
        await fs.writeFile(filePath, lines.join("\n"));
    }
    return added;
}

/** The repo named, or the one we are standing in. Checked the same way securessh checks it: a git
    repo that actually holds keys and has an origin to clone from. */
async function resolveKeysRepo(named: string | undefined) {
    let cwd = named && expandHome(named) || undefined;
    // spawnPromise rather than runPromise, because these two are read for their value. runPromise
    // returns stdout and stderr joined, so one git warning ends up glued to the front of the path.
    let topLevel = await spawnPromise({ command: "git", args: ["rev-parse", "--show-toplevel"], cwd });
    let repoPath = topLevel.stdout.trim();
    if (topLevel.status !== 0 || !repoPath) {
        throw new Error(
            `Expected ${named || "the current directory"} to be inside a git repo, it is not.\n`
            + `${(topLevel.stdout + topLevel.stderr).trim()}\n${USAGE}`
        );
    }
    try {
        await readRepoKeys(repoPath);
    } catch (e) {
        throw new Error(`Expected ${repoPath} to be a keys repo, it holds no keys.\n${e}\n${USAGE}`);
    }
    let origin = await spawnPromise({ command: "git", args: ["remote", "get-url", "origin"], cwd: repoPath });
    let originURL = origin.stdout.trim();
    if (origin.status !== 0 || !originURL) {
        throw new Error(`Expected ${repoPath} to have an origin remote, it has none.\n${USAGE}`);
    }
    return { repoPath, originURL };
}

export async function main() {
    let argv = process.argv.slice(2);
    let pushToGit = argv.includes(GIT_KEYWORD);
    let positional = argv.filter(arg => arg !== GIT_KEYWORD);
    if (positional.length > 1) {
        throw new Error(`Expected at most a keys repo, was ${positional.length} argument(s)\n${USAGE}`);
    }
    let { repoPath, originURL } = await resolveKeysRepo(positional[0]);

    let revocations = await readRemoteRevocations({ sourceURL: originURL });
    if (!revocations.length) {
        console.log(`${revokeRepoURL(originURL)} lists no revocations, so there is nothing to undo.`);
        return;
    }

    let directory = path.join(repoPath, UNREVOKES_DIR);
    await fs.mkdir(directory, { recursive: true });
    let stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let unrevokeId = `${stamp}-unrevoke`;
    await fs.writeFile(path.join(directory, `${unrevokeId}.json`), JSON.stringify({
        unrevokeId,
        createdAt: new Date().toISOString(),
        // What this file says: each of these keys is allowed from this address. Pairs, not keys,
        // and not a blanket "allow everything again" - a key forgiven here for one address is
        // still revoked the moment it is used from another.
        allowed: revocations.map(revocation => ({
            fingerprint: revocation.fingerprint,
            ip: revocationIP(revocation),
        })),
        revocations: revocations.map(revocation => ({
            revocationId: revocation.revocationId,
            fingerprint: revocation.fingerprint,
            ip: revocationIP(revocation),
            revokedAt: revocation.revokedAt,
            revokedBy: revocation.revokedBy,
            attempt: revocation.attempt,
        })),
    }, undefined, 4) + "\n");

    // Named the way the notifications name them. A fingerprint is not in authorized_keys and
    // cannot be worked out by eye, so on its own it tells whoever is reading this nothing about
    // which of their keys is being talked about.
    let keysByFingerprint = new Map<string, string>();
    for (let key of await readRepoKeys(repoPath).catch(() => [] as string[])) {
        keysByFingerprint.set(keyFingerprint(key), key);
    }
    let describeKey = (revocation: Revocation) => {
        let key = keysByFingerprint.get(revocation.fingerprint) || revocation.key || "";
        return key && summarizeKey(key) || `a key no longer in this repo (${revocation.fingerprint})`;
    };

    let addressesByFingerprint = new Map<string, string[]>();
    for (let revocation of revocations) {
        let ip = revocationIP(revocation);
        let existing = addressesByFingerprint.get(revocation.fingerprint) || [];
        if (ip && !existing.includes(ip)) {
            existing.push(ip);
        }
        addressesByFingerprint.set(revocation.fingerprint, existing);
    }

    // Cancelling the revocation on its own would leave sshd refusing that address and the machines
    // revoking the key all over again, so the addresses go into the key's from= here. We are in
    // the repo that owns authorized_keys, so there is nothing to hand back to whoever ran this.
    let added = await allowAddressesInRepo({ repoPath, addressesByFingerprint });

    console.log("");
    for (let [fingerprint, addresses] of addressesByFingerprint) {
        let revocation = revocations.find(entry => entry.fingerprint === fingerprint)!;
        console.log(`Unfreezing ${describeKey(revocation)}`);
        console.log(`Allowing IP ${addresses.join(", ") || "(no address recorded)"}`);
        let addedHere = added.get(fingerprint) || [];
        if (addedHere.length) {
            console.log(`  added to that key's from= list in authorized_keys: ${addedHere.join(", ")}`);
        } else {
            console.log(`  that key's from= list already allowed ${addresses.join(", ") ? "them" : "everything"}`);
        }
        for (let entry of revocations.filter(entry => entry.fingerprint === fingerprint)) {
            console.log(
                `  frozen by ${entry.revokedBy || "?"} ${entry.revokedAt || "at an unrecorded time"}`
            );
        }
        console.log("");
    }
    console.log(`Every other address stays frozen, and one of these keys used from anywhere else`);
    console.log(`is frozen again.`);

    // Signed here rather than left as a step to remember. An unrevoke nobody signed does nothing at
    // all, and the repo would sit there looking done while every machine ignored it.
    await signRepo({ repoPath });

    if (!pushToGit) {
        console.log(`\nCommit and push it, and each machine will wait an hour after seeing it before`);
        console.log(`those keys work again:`);
        console.log(`\`\`\`\ngit add -A\ngit commit -m "${COMMIT_MESSAGE}"\ngit push\n\`\`\``);
        return;
    }
    await runPromise(`git add -A`, { cwd: repoPath });
    await runPromise(`git commit -m "${COMMIT_MESSAGE}"`, { cwd: repoPath });
    await runPromise(`git push`, { cwd: repoPath });
    console.log(`\nCommitted and pushed. Each machine waits an hour after seeing it before those`);
    console.log(`keys work again.`);
}
