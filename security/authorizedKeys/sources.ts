import fs from "fs/promises";
import os from "os";
import path from "path";

// PORTED CODE: nothing here is duplicated any more, the daemon imports it directly. Kept in one
// place because the daemon and the deploy have to agree on where a source's key and checkout live.

// The user's own folder, so this works the same on a machine that has no /etc. The daemon runs as
// root, so on a host this is root's home.
export const KEYS_DIR_NAME = "authorized_keys";
// Where keys used to go. Still read, so a host set up before this keeps working, but nothing is
// written here any more.
export const LEGACY_REPO_KEYS_DIR = "/etc/portsecure/repo-keys";
export const REPOS_DIR = "/var/lib/portsecure/authorized-keys-repos";

export function keysDir() {
    return path.join(os.homedir(), KEYS_DIR_NAME);
}

/** A repo url reduced to something usable as a file name. Derived rather than configured, so the
    daemon and the deploy script always agree on where a source's key and checkout live. */
export function sourceName(repoURL: string) {
    return repoURL.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export function sourceKeyPath(repoURL: string) {
    return path.join(keysDir(), sourceName(repoURL));
}

export function legacySourceKeyPath(repoURL: string) {
    return `${LEGACY_REPO_KEYS_DIR}/${sourceName(repoURL)}`;
}

export function sourceRepoPath(repoURL: string) {
    return `${REPOS_DIR}/${sourceName(repoURL)}`;
}

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

/** The key for a source, wherever it happens to be. The user folder is where they go now, and the
    old location is still read so a host that predates the move keeps working. */
export async function findKey(config: { current: string; legacy: string }) {
    let { current, legacy } = config;
    if (await pathExists(current)) {
        return current;
    }
    if (await pathExists(legacy)) {
        return legacy;
    }
    return "";
}

export async function findSourceKey(repoURL: string) {
    return await findKey({ current: sourceKeyPath(repoURL), legacy: legacySourceKeyPath(repoURL) });
}
