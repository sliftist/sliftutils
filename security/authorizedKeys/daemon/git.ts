import fs from "fs/promises";
import path from "path";
import { spawnPromise } from "../../helpers/spawn";
import { findSourceKey, sourceKeyPath, sourceRepoPath } from "../sources";
import { GIT_TIMEOUT, MAX_ERROR_BODY_LENGTH } from "./paths";
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
        console.log(`Repo at ${repoPath} is not usable. ${(result.stdout + result.stderr).trim()}`);
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
    console.log(`Cloned ${repoURL} into ${repoPath}`);
}

export async function currentBranch(config: { repoPath: string; keyPath: string }) {
    return (await runGit({ args: ["rev-parse", "--abbrev-ref", "HEAD"], ...config })).stdout.trim();
}

/** Forces a checkout's working tree to a ref. Anything local - an edited file, or a stray untracked
    one - is staged and stashed rather than deleted, so the tree comes out clean but nothing is lost
    for good: it sits in a stash if it is ever wanted. */
export async function setGitRef(config: { repoPath: string; gitRef: string; keyPath: string }) {
    let { repoPath, gitRef, keyPath } = config;
    // Staging the untracked files first is what lets the stash carry them off, so the reset lands
    // on a genuinely clean tree.
    await runGit({ args: ["add", "--all"], cwd: repoPath, keyPath, allowFailure: true });
    // A checkout with nothing to stash makes git stash exit non-zero, which is harmless here - the
    // reset below is what actually forces the tree.
    await runGit({ args: ["stash"], cwd: repoPath, keyPath, allowFailure: true });
    await runGit({ args: ["fetch", "--prune", "origin"], cwd: repoPath, keyPath });
    await runGit({ args: ["reset", "--hard", gitRef], cwd: repoPath, keyPath });
    // Drops objects nothing references any more, so a file committed by mistake cannot bloat the
    // checkout forever. Reflogs keep the just-replaced commit reachable, so a history rewrite is
    // still detectable right after this.
    await runGit({ args: ["prune"], cwd: repoPath, keyPath, allowFailure: true });
}

async function ensureSourceRepo(repoURL: string) {
    let repoPath = sourceRepoPath(repoURL);
    let keyPath = await findSourceKey(repoURL) || sourceKeyPath(repoURL);
    if (!await repoIsUsable({ repoPath, keyPath })) {
        await cloneRepo({ repoURL, repoPath, keyPath });
    }
    if (!sourceState(repoURL).branch) {
        sourceState(repoURL).branch = await currentBranch({ repoPath, keyPath });
    }
}

/** Returns what changed, so the caller can report it. A rewritten history is called out
    separately - it means the remote no longer contains the commits we already had.

    forceUpdate forces the working tree back to the remote even when the remote has not moved, which
    is what heals a checkout left dirty - an edited or half-written file that no longer matches its
    signature. It would be maddening to a developer editing the repo in place, since it stashes their
    uncommitted work; but make sure nothing that answers this checkout is running on the machine you
    edit on. If the checkout went dirty because a machine connection triggered a revocation, kill the
    services on that machine before you touch the trusted machines, or they will just dirty it again. */
export async function syncRepo(repoURL: string, options?: { forceUpdate?: boolean }) {
    await ensureSourceRepo(repoURL);
    let repoPath = sourceRepoPath(repoURL);
    let keyPath = await findSourceKey(repoURL) || sourceKeyPath(repoURL);
    let branch = sourceState(repoURL).branch;
    let localSha = (await runGit({ args: ["rev-parse", "HEAD"], cwd: repoPath, keyPath })).stdout.trim();

    // A ref listing is a few hundred bytes and no objects, so the usual case of nothing having
    // changed costs almost nothing and we only fetch when there is something to fetch.
    let listing = (await runGit({ args: ["ls-remote", "origin", branch], cwd: repoPath, keyPath })).stdout;
    let remoteSha = (listing.split(/\s+/)[0] || "").trim();
    if (!remoteSha) {
        throw new Error(`Expected origin to report a sha for ${branch}, listed ${listing.slice(0, MAX_ERROR_BODY_LENGTH)}`);
    }
    if (!options?.forceUpdate && remoteSha === localSha && remoteSha === sourceState(repoURL).lastSha) {
        return { changed: false, historyRewritten: false, remoteSha, previousSha: localSha };
    }

    // The remote has moved, or we have not applied it yet, so force the checkout to it.
    let previousSha = sourceState(repoURL).lastSha || localSha;
    await setGitRef({ repoPath, gitRef: `origin/${branch}`, keyPath });
    remoteSha = (await runGit({ args: ["rev-parse", `origin/${branch}`], cwd: repoPath, keyPath })).stdout.trim();

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
    return { changed: true, historyRewritten, remoteSha, previousSha };
}
