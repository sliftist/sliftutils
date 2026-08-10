// PORTED CODE: security/authorizedKeys/daemon/portsecureDaemon.js contains a plain JS port of everything here, so it can
// resolve the same locations with no dependencies. Both sides must derive identical paths from a
// repo url - if you change one, make the matching change in the other.

export const REPO_KEYS_DIR = "/etc/portsecure/repo-keys";
export const REPOS_DIR = "/var/lib/portsecure/authorized-keys-repos";

/** A repo url reduced to something usable as a file name. Derived rather than configured, so the
    daemon and the deploy script always agree on where a source's key and checkout live. */
export function sourceName(repoURL: string) {
    return repoURL.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export function sourceKeyPath(repoURL: string) {
    return `${REPO_KEYS_DIR}/${sourceName(repoURL)}`;
}

export function sourceRepoPath(repoURL: string) {
    return `${REPOS_DIR}/${sourceName(repoURL)}`;
}
