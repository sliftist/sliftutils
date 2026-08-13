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
/** The key for a source, wherever it happens to be. The user folder is where they go now, and the
    old location is still read so a host that predates the move keeps working. */
export declare function findKey(config: {
    current: string;
    legacy: string;
}): Promise<string>;
export declare function findSourceKey(repoURL: string): Promise<string>;
