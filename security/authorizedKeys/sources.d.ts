export declare const KEYS_DIR_NAME = "authorized_keys";
export declare const LEGACY_REPO_KEYS_DIR = "/etc/portsecure/repo-keys";
export declare const REPOS_DIR = "/var/lib/portsecure/authorized-keys-repos";
export declare function keysDir(): string;
/** A repo url reduced to something usable as a file name. Derived rather than configured, so the
    daemon and the deploy script always agree on where a source's key and checkout live. */
export declare function sourceName(repoURL: string): string;
export declare function sourceKeyPath(repoURL: string): string;
export declare function legacySourceKeyPath(repoURL: string): string;
export declare function sourceRepoPath(repoURL: string): string;
export declare function findKey(config: {
    current: string;
    legacy: string;
}): Promise<string>;
/** What is at each place the key could be, for whoever has to be told it was not found. "No such
    file" is a lie when a directory of that name is sitting right there, and it is the one case
    where saying so is the whole answer. */
export declare function describeMissingKey(config: {
    current: string;
    legacy: string;
}): Promise<string>;
export declare function findSourceKey(repoURL: string): Promise<string>;
export declare function describeMissingSourceKey(repoURL: string): Promise<string>;
