import fs from "fs/promises";
import path from "path";
import { spawnPromise } from "../../helpers/spawn";
import { sourceKeyPath, sourceRepoPath } from "../sources";
import { GIT_TIMEOUT, MAX_ERROR_BODY_LENGTH } from "./paths";
import { log } from "./notify";
import { sourceState } from "./state";

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

/** core.sshCommand keeps the key selection with the command instead of in the environment. */
export async function runGit(config: { args: string[]; cwd?: string; keyPath: string; allowFailure?: boolean }) {
    let { args, cwd, keyPath, allowFailure } = config;
    let sshCommand = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
    let result = await spawnPromise({
        command: "git",
        args: ["-c", `core.sshCommand=${sshCommand}`, ...args],
        cwd,
        timeoutTime: GIT_TIMEOUT,
    });
    if (result.error) {
        throw new Error(`Expected git ${args.join(" ")} to run, failed with ${result.error.message}`);
    }
    if (result.status !== 0 && !allowFailure) {
        throw new Error(
            `Expected git ${args.join(" ")} to exit 0, was ${result.status}. `
            + `${(result.stdout + result.stderr).trim().slice(0, MAX_ERROR_BODY_LENGTH)}`
        );
    }
    return result;
}

export async function repoIsUsable(config: { repoPath: string; keyPath: string }) {
    let { repoPath, keyPath } = config;
    if (!await pathExists(path.join(repoPath, ".git"))) {
        return false;
    }
    let result = await runGit({ args: ["rev-parse", "--git-dir"], cwd: repoPath, keyPath, allowFailure: true });
    if (result.status !== 0) {
        log(`Repo at ${repoPath} is not usable. ${(result.stdout + result.stderr).trim()}`);
        return false;
    }
    return true;
}

/** Cloned beside the old checkout and swapped in, so a clone that fails leaves the copy we are
    already using untouched rather than deleting the only keys we have. */
export async function cloneRepo(config: { repoURL: string; repoPath: string; keyPath: string }) {
    let { repoURL, repoPath, keyPath } = config;
    let incomingPath = `${repoPath}.incoming`;
    await fs.rm(incomingPath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(repoPath), { recursive: true });
    await runGit({ args: ["clone", repoURL, incomingPath], keyPath });
    await fs.rm(repoPath, { recursive: true, force: true });
    await fs.rename(incomingPath, repoPath);
    log(`Cloned ${repoURL} into ${repoPath}`);
}

export async function currentBranch(config: { repoPath: string; keyPath: string }) {
    return (await runGit({ args: ["rev-parse", "--abbrev-ref", "HEAD"], ...config })).stdout.trim();
}

async function ensureSourceRepo(repoURL: string) {
    let repoPath = sourceRepoPath(repoURL);
    let keyPath = sourceKeyPath(repoURL);
    if (!await repoIsUsable({ repoPath, keyPath })) {
        await cloneRepo({ repoURL, repoPath, keyPath });
    }
    if (!sourceState(repoURL).branch) {
        sourceState(repoURL).branch = await currentBranch({ repoPath, keyPath });
    }
}

/** Returns what changed, so the caller can report it. A rewritten history is called out
    separately - it means the remote no longer contains the commits we already had. */
export async function syncRepo(repoURL: string) {
    await ensureSourceRepo(repoURL);
    let repoPath = sourceRepoPath(repoURL);
    let keyPath = sourceKeyPath(repoURL);
    let branch = sourceState(repoURL).branch;
    let localSha = (await runGit({ args: ["rev-parse", "HEAD"], cwd: repoPath, keyPath })).stdout.trim();

    // A ref listing is a few hundred bytes and no objects, so the usual case of nothing having
    // changed costs almost nothing and we only fetch when there is something to fetch.
    let listing = (await runGit({ args: ["ls-remote", "origin", branch], cwd: repoPath, keyPath })).stdout;
    let remoteSha = (listing.split(/\s+/)[0] || "").trim();
    if (!remoteSha) {
        throw new Error(`Expected origin to report a sha for ${branch}, listed ${listing.slice(0, MAX_ERROR_BODY_LENGTH)}`);
    }
    if (remoteSha === localSha && remoteSha === sourceState(repoURL).lastSha) {
        return { changed: false, historyRewritten: false, remoteSha, previousSha: localSha };
    }

    await runGit({ args: ["fetch", "--prune", "origin", branch], cwd: repoPath, keyPath });
    remoteSha = (await runGit({ args: ["rev-parse", `origin/${branch}`], cwd: repoPath, keyPath })).stdout.trim();

    let previousSha = sourceState(repoURL).lastSha || localSha;
    let historyRewritten = false;
    if (previousSha && previousSha !== remoteSha) {
        // If what we already had is no longer an ancestor of the remote tip, commits were removed
        // or rewritten rather than added.
        let ancestry = await runGit({
            args: ["merge-base", "--is-ancestor", previousSha, remoteSha],
            cwd: repoPath,
            keyPath,
            allowFailure: true,
        });
        historyRewritten = ancestry.status !== 0;
    }
    await runGit({ args: ["reset", "--hard", `origin/${branch}`], cwd: repoPath, keyPath });
    await runGit({ args: ["clean", "-fdx"], cwd: repoPath, keyPath });
    return { changed: true, historyRewritten, remoteSha, previousSha };
}
