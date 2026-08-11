import fs from "fs/promises";
import os from "os";
import path from "path";
import { runPromise } from "socket-function/src/runPromise";
import { keyFingerprint, normalizeKeys } from "./authorizedKeys";
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
    key?: string;
    revokedAt?: string;
    revokedBy?: string;
    attempt?: { ip?: string; user?: string; required?: string };
};

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
