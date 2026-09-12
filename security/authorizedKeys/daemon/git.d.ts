/** core.sshCommand keeps the key selection with the command instead of in the environment. */
export declare function runGit(config: {
    args: string[];
    cwd?: string;
    keyPath: string;
    allowFailure?: boolean;
}): Promise<{
    stdout: string;
    stderr: string;
    status: number | undefined;
    error: Error | undefined;
}>;
export declare function repoIsUsable(config: {
    repoPath: string;
    keyPath: string;
}): Promise<boolean>;
/** Cloned beside the old checkout and swapped in, so a clone that fails leaves the copy we are
    already using untouched rather than deleting the only keys we have. */
export declare function cloneRepo(config: {
    repoURL: string;
    repoPath: string;
    keyPath: string;
}): Promise<void>;
export declare function currentBranch(config: {
    repoPath: string;
    keyPath: string;
}): Promise<string>;
/** Forces a checkout's working tree to a ref. Anything local - an edited file, or a stray untracked
    one - is staged and stashed rather than deleted, so the tree comes out clean but nothing is lost
    for good: it sits in a stash if it is ever wanted. */
export declare function setGitRef(config: {
    repoPath: string;
    gitRef: string;
    keyPath: string;
}): Promise<void>;
/** Returns what changed, so the caller can report it. A rewritten history is called out
    separately - it means the remote no longer contains the commits we already had.

    forceUpdate forces the working tree back to the remote even when the remote has not moved, which
    is what heals a checkout left dirty - an edited or half-written file that no longer matches its
    signature. It would be maddening to a developer editing the repo in place, since it stashes their
    uncommitted work; but make sure nothing that answers this checkout is running on the machine you
    edit on. If the checkout went dirty because a machine connection triggered a revocation, kill the
    services on that machine before you touch the trusted machines, or they will just dirty it again. */
export declare function syncRepo(repoURL: string, options?: {
    forceUpdate?: boolean;
}): Promise<{
    changed: boolean;
    historyRewritten: boolean;
    remoteSha: string;
    previousSha: string;
}>;
