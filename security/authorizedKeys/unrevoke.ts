import fs from "fs/promises";
import os from "os";
import path from "path";
import { runPromise } from "socket-function/src/runPromise";
import { keyFingerprint, normalizeKeys } from "./authorizedKeys";
import { deriveRevokeKey, revokeRepoURL } from "./revokeSource";
import { expandHome } from "../helpers/paths";
import { spawnPromise } from "../helpers/spawn";

const UNREVOKES_DIR = "unrevoked";
const REVOCATIONS_DIR = "revocations";
const USAGE = `Usage: yarn unrevoke <source-repo-private-key>

Run this in a keys repo. It reads that repo's revoke repo and writes one unrevoke file naming
every revocation in it, so the keys are accepted again once each machine's hour long wait passes.

Keys that were revoked should normally be deleted from the repo instead. Unrevoking only matters
for a key you still want.`;

export type Revocation = {
    revocationId: string;
    fingerprint: string;
    key?: string;
    revokedAt?: string;
    revokedBy?: string;
    attempt?: { ip?: string; user?: string; required?: string };
};

/** Every revocation the revoke repo lists. Cloned read only into a temp directory, since this runs
    on a developer machine that has no business holding a checkout of it. */
export async function readRemoteRevocations(config: { sourceURL: string; keyPath: string }) {
    let { sourceURL, keyPath } = config;
    let derived = deriveRevokeKey(await fs.readFile(keyPath, "utf8"));
    let temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "unrevoke-"));
    let derivedKeyPath = path.join(temporaryDirectory, "key");
    await fs.writeFile(derivedKeyPath, derived.privateKeyFile, { mode: 0o600 });
    let repoPath = path.join(temporaryDirectory, "repo");
    let sshCommand = `ssh -i ${derivedKeyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
    let clone = await spawnPromise({
        command: "git",
        args: ["-c", `core.sshCommand=${sshCommand}`, "clone", "--depth", "1", revokeRepoURL(sourceURL), repoPath],
    });
    if (clone.status !== 0) {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
        throw new Error(
            `Expected ${revokeRepoURL(sourceURL)} to be readable with the key derived from ${keyPath}.\n`
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
export async function revokedKeysInRepo(config: { repoPath: string; sourceURL: string; keyPath: string }) {
    let { repoPath, sourceURL, keyPath } = config;
    let revocations = await readRemoteRevocations({ sourceURL, keyPath });
    let revokedFingerprints = new Set(revocations.map(revocation => revocation.fingerprint));
    let unrevoked = new Set<string>();
    try {
        let directory = path.join(repoPath, UNREVOKES_DIR);
        for (let name of await fs.readdir(directory)) {
            if (!name.endsWith(".json")) {
                continue;
            }
            let parsed = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
            for (let revocationId of parsed.revocationIds || []) {
                unrevoked.add(revocationId);
            }
        }
    } catch (e) {
        // Nothing has been unrevoked.
    }
    let stillRevoked = revocations.filter(revocation => !unrevoked.has(revocation.revocationId));
    let keys = normalizeKeys(await fs.readFile(path.join(repoPath, "authorized_keys"), "utf8").catch(() => ""));
    return stillRevoked
        .filter(revocation => keys.some(key => keyFingerprint(key) === revocation.fingerprint))
        .map(revocation => ({ revocation, key: keys.find(key => keyFingerprint(key) === revocation.fingerprint) || "" }));
}

export async function main() {
    let argv = process.argv.slice(2);
    if (argv.length !== 1) {
        throw new Error(`Expected the source repo's private key, was ${argv.length} argument(s)\n${USAGE}`);
    }
    let keyPath = expandHome(argv[0]);

    let repoPath = (await runPromise("git rev-parse --show-toplevel", { quiet: true })).trim();
    let originURL = (await runPromise("git remote get-url origin", { quiet: true })).trim();
    if (!repoPath || !originURL) {
        throw new Error(`Expected the current directory to be a git repo with an origin, it is not.\n${USAGE}`);
    }

    let revocations = await readRemoteRevocations({ sourceURL: originURL, keyPath });
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
        // Named one by one rather than as a blanket "allow everything again", so this file only
        // ever undoes the revocations that existed when it was written.
        revocationIds: revocations.map(revocation => revocation.revocationId),
        revocations: revocations.map(revocation => ({
            revocationId: revocation.revocationId,
            fingerprint: revocation.fingerprint,
            revokedAt: revocation.revokedAt,
            revokedBy: revocation.revokedBy,
            attempt: revocation.attempt,
        })),
    }, undefined, 4) + "\n");

    console.log(`Wrote ${UNREVOKES_DIR}/${unrevokeId}.json covering ${revocations.length} revocation(s):`);
    for (let revocation of revocations) {
        console.log(`  ${revocation.fingerprint} revoked by ${revocation.revokedBy || "?"} from ${revocation.attempt?.ip || "?"}`);
    }
    console.log(`Each machine waits an hour after seeing it before the keys work again.`);
    console.log(`Sign and publish it with:\n  yarn signfiles git`);
}
