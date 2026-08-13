import fs from "fs/promises";
import path from "path";
import { deriveRevokeKey, findRevokeKey, REVOKE_KEY_LABEL, revokeKeyPath, revokeRepoPath, revokeRepoURL } from "../revokeSource";
import { findSourceKey, sourceKeyPath, sourceRepoPath } from "../sources";
import { cloneRepo, repoIsUsable, runGit, setGitRef } from "./git";

/** Reading a repo, made to look like reading a directory. A caller asks for a file and gets its
    contents; keeping a checkout on disk, cloning it once and pulling it since, is this module's
    business and nobody else's.

    Nothing here ever answers "there is nothing" when the truth is "I could not look". A repo that
    cannot be reached throws, and the caller skips that source, because reading an unreachable
    revoke repo as empty would un-revoke every key in it. */
export type RepoRef = {
    repoURL: string;
    repoPath: string;
    keyPath: () => Promise<string>;
};

export function sourceRepo(sourceURL: string): RepoRef {
    return {
        repoURL: sourceURL,
        repoPath: sourceRepoPath(sourceURL),
        keyPath: async () => await findSourceKey(sourceURL) || sourceKeyPath(sourceURL),
    };
}

export function revokeRepo(sourceURL: string): RepoRef {
    return {
        repoURL: revokeRepoURL(sourceURL),
        repoPath: revokeRepoPath(sourceURL),
        keyPath: () => ensureRevokeKey(sourceURL),
    };
}

/** The revoke repo's key is worked out from the source's, so nothing extra had to be uploaded and
    nothing extra is stored anywhere it could be taken from. */
export async function ensureRevokeKey(sourceURL: string) {
    let existing = await findRevokeKey(sourceURL);
    if (existing) {
        return existing;
    }
    let sourceKey = await findSourceKey(sourceURL);
    if (!sourceKey) {
        throw new Error(`Expected a key for ${sourceURL} at ${sourceKeyPath(sourceURL)}, no such file exists`);
    }
    let derived = deriveRevokeKey(await fs.readFile(sourceKey, "utf8"));
    let keyPath = revokeKeyPath(sourceURL);
    await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(keyPath, derived.privateKeyFile, { mode: 0o600 });
    await fs.writeFile(`${keyPath}.pub`, `${derived.publicKey} ${REVOKE_KEY_LABEL}\n`, { mode: 0o644 });
    console.log(`Derived the revoke key for ${sourceURL} into ${keyPath}`);
    return keyPath;
}

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

/** Brings the checkout in line with the remote. Cloned the first time, pulled after that, and the
    usual case of nothing having changed costs one ref listing and no objects. Throws if the repo
    cannot be read, so a caller cannot mistake that for an empty repo. */
export async function syncRepoFiles(repo: RepoRef) {
    let { repoURL, repoPath } = repo;
    let keyPath = await repo.keyPath();
    if (!await repoIsUsable({ repoPath, keyPath })) {
        await cloneRepo({ repoURL, repoPath, keyPath });
        return;
    }
    let localHead = await runGit({ args: ["rev-parse", "HEAD"], cwd: repoPath, keyPath, allowFailure: true });
    if (localHead.status !== 0) {
        // A repo with no commits yet, which is the state every revoke repo starts in. There is
        // nothing to pull and nothing to say.
        return;
    }
    let branch = (await runGit({ args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: repoPath, keyPath })).stdout.trim();
    let listing = (await runGit({ args: ["ls-remote", "origin", branch], cwd: repoPath, keyPath })).stdout;
    let remoteSha = (listing.split(/\s+/)[0] || "").trim();
    if (remoteSha && remoteSha === localHead.stdout.trim()) {
        return;
    }
    await setGitRef({ repoPath, gitRef: `origin/${branch}`, keyPath });
}

/** Throws when there is no checkout at all. "I have never managed to read this repo" and "this
    repo is empty" are different answers and must not collapse into one. */
async function requireCheckout(repo: RepoRef) {
    if (!await pathExists(path.join(repo.repoPath, ".git"))) {
        throw new Error(`Expected a checkout of ${repo.repoURL} at ${repo.repoPath}, there is none`);
    }
}

/** One file out of the repo, or undefined if the repo does not have that file. */
export async function readRepoFile(repo: RepoRef, filePath: string) {
    await requireCheckout(repo);
    try {
        return await fs.readFile(path.join(repo.repoPath, filePath), "utf8");
    } catch (e) {
        return undefined;
    }
}

/** The names in one of the repo's directories, or nothing if it has no such directory. */
export async function listRepoDir(repo: RepoRef, directory: string) {
    await requireCheckout(repo);
    try {
        return (await fs.readdir(path.join(repo.repoPath, directory))).sort();
    } catch (e) {
        return [];
    }
}
