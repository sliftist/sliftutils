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

/** The key for a source, wherever it happens to be. The user folder is where they go now, and the
    old location is still read so a host that predates the move keeps working. */
/** A key has to be the file itself. Something else of that name - most often a directory somebody
    made to put the key inside - is not a key, and answering with it means whoever reads it gets
    "illegal operation on a directory" instead of being told the key is missing. */
async function keyFile(filePath: string) {
    let stats = await fs.stat(filePath).catch(() => undefined);
    return stats?.isFile() && filePath || "";
}

export async function findKey(config: { current: string; legacy: string }) {
    return await keyFile(config.current) || await keyFile(config.legacy);
}

/** What is at each place the key could be, for whoever has to be told it was not found. "No such
    file" is a lie when a directory of that name is sitting right there, and it is the one case
    where saying so is the whole answer. */
export async function describeMissingKey(config: { current: string; legacy: string }) {
    let describe = async (filePath: string) => {
        let stats = await fs.stat(filePath).catch(() => undefined);
        if (!stats) {
            return `${filePath} (nothing there)`;
        }
        if (stats.isDirectory()) {
            return `${filePath} (a directory - the key has to BE this path, not a file inside it)`;
        }
        return `${filePath} (not a regular file)`;
    };
    return `${await describe(config.current)}, and ${await describe(config.legacy)}`;
}

export async function findSourceKey(repoURL: string) {
    return await findKey({ current: sourceKeyPath(repoURL), legacy: legacySourceKeyPath(repoURL) });
}

export async function describeMissingSourceKey(repoURL: string) {
    return await describeMissingKey({ current: sourceKeyPath(repoURL), legacy: legacySourceKeyPath(repoURL) });
}
