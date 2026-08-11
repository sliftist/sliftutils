import fs from "fs/promises";
import os from "os";
import path from "path";
import { CONFIG_PATH } from "./daemon/paths";
import { readRepoKeys } from "./authorizedKeys";
import { sourceRepoPath } from "./sources";
import { expandHome } from "../helpers/paths";
import { spawnPromise } from "../helpers/spawn";

// The one place that answers "which keys repo". Everything that reads or writes one comes here:
// signing, unrevoking, machine trust, and adding a machine. They were each working it out their
// own way, which is how signfiles ended up signing whatever repo you happened to be standing in.
//
// Where a Windows machine is expected to keep it, relative to the working directory. There is no
// daemon there and no /etc, so a sibling checkout is the convention.
const WINDOWS_REPO_PATH = "../authorized_keys";

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

/** A git checkout that actually holds keys. Both halves matter: a repo with no authorized_keys is
    some other repo, and a directory that is not a checkout has nothing to push. */
async function isKeysRepo(repoPath: string) {
    if (!await pathExists(path.join(repoPath, ".git"))) {
        return false;
    }
    try {
        await readRepoKeys(repoPath);
        return true;
    } catch (e) {
        return false;
    }
}

/** The repo the working directory is inside, or "" when it is not inside one. */
async function repoOfCurrentDirectory() {
    // Read for its value, so stdout has to be on its own. runPromise joins it with stderr, and a
    // git warning glued to the front of this becomes a directory that does not exist.
    let topLevel = await spawnPromise({ command: "git", args: ["rev-parse", "--show-toplevel"] });
    return topLevel.status === 0 && topLevel.stdout.trim() || "";
}

/** Where this machine's own keys repo is, when the working directory is not one.

    On a host that is the checkout the daemon keeps up to date. On Windows there is no daemon, so
    it is the sibling directory. */
async function configuredRepo() {
    if (os.platform() === "win32") {
        return path.resolve(WINDOWS_REPO_PATH);
    }
    let config = await fs.readFile(CONFIG_PATH, "utf8").catch(() => "");
    let sourceURL = config && (JSON.parse(config).repoSources || [])[0] || "";
    return sourceURL && sourceRepoPath(sourceURL) || "";
}

async function originOf(repoPath: string) {
    let origin = await spawnPromise({ command: "git", args: ["remote", "get-url", "origin"], cwd: repoPath });
    let url = origin.stdout.trim();
    if (origin.status !== 0 || !url) {
        throw new Error(`Expected ${repoPath} to have an origin remote, it has none`);
    }
    return url;
}

/** The keys repo to act on.

    A named one if there is one, otherwise the repo the command is being run in if that repo holds
    keys, otherwise this machine's own. Running in some other repo therefore reaches the keys repo
    rather than acting on whatever happened to be around - signing sliftutils because that is where
    the terminal was is never what anybody meant. */
export async function resolveKeysRepo(named?: string): Promise<{ repoPath: string; sourceURL: string }> {
    let tried: string[] = [];

    let candidates: string[] = [];
    if (named) {
        candidates.push(expandHome(named));
    } else {
        let current = await repoOfCurrentDirectory();
        if (current) {
            candidates.push(current);
        }
        let configured = await configuredRepo();
        if (configured && configured !== current) {
            candidates.push(configured);
        }
    }

    for (let repoPath of candidates) {
        if (await isKeysRepo(repoPath)) {
            return { repoPath, sourceURL: await originOf(repoPath) };
        }
        tried.push(repoPath);
    }

    throw new Error(
        `Expected a git repo holding authorized_keys, found none.\n`
        + `Looked in:\n  ${tried.join("\n  ") || "(nowhere - this is not a git repo)"}\n`
        + (os.platform() === "win32"
            ? `On Windows the repo is read from ${path.resolve(WINDOWS_REPO_PATH)}, so clone it there:\n`
            + `  git clone <your authorized_keys repo> ${path.resolve(WINDOWS_REPO_PATH)}`
            : `Set this machine up, or run this from inside a keys repo:\n`
            + `  yarn setupnotify <discord-webhook-url>\n`
            + `  yarn securessh add <repo-private-key> <repo-url>`)
    );
}
