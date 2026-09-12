/** The keys repo to act on.

    A named one if there is one, otherwise the repo the command is being run in if that repo holds
    keys, otherwise this machine's own. Running in some other repo therefore reaches the keys repo
    rather than acting on whatever happened to be around - signing sliftutils because that is where
    the terminal was is never what anybody meant. */
export declare function resolveKeysRepo(named?: string): Promise<{
    repoPath: string;
    sourceURL: string;
}>;
