import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { spawnPromise } from "../helpers/spawn";

// PORTED CODE: security/authorizedKeys/daemon/portsecureDaemon.js contains a plain JS port of the
// verifying half of this file, so it can check a signature with no dependencies. Both sides must
// agree on the manifest shape and on which files it covers - if you change one, make the matching
// change in the other.

export const MANIFEST_NAME = "signedfiles.json";
export const SIGNATURE_NAME = "signedfiles.json.sig";
// ssh signatures are namespaced, so a signature made for one purpose cannot be replayed as another.
export const SIGN_NAMESPACE = "signfiles";
export const MANIFEST_VERSION = 1;

export type Manifest = {
    version: number;
    files: { path: string; size: number; sha256: string }[];
};

/** Everything in the repo that is not ignored, which is exactly what a clone of it will contain.
    The manifest and its signature are left out, since they cannot describe themselves. */
export async function listRepoFiles(repoPath: string) {
    let result = await spawnPromise({
        command: "git",
        args: ["ls-files", "--cached", "--others", "--exclude-standard"],
        cwd: repoPath,
    });
    if (result.status !== 0) {
        throw new Error(
            `Expected to list the files in ${repoPath}, git ls-files exited ${result.status}. `
            + `${(result.stdout + result.stderr).trim()}`
        );
    }
    return result.stdout.split("\n")
        .map(line => line.trim())
        .filter(line => line && line !== MANIFEST_NAME && line !== SIGNATURE_NAME)
        .sort();
}

/** A Windows checkout turns LF into CRLF, so the same commit hashes differently there than it
    does on the machine that pulls it. Normalising first makes the digest describe the content
    rather than whichever checkout produced it. latin1 round trips every byte, so this is safe on
    files that are not text. */
export function normalizeContent(contents: Buffer) {
    return Buffer.from(contents.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
}

/** The size and hash of a file's normalised content. The size is the normalised one on purpose,
    so it agrees with the hash rather than with whatever the local checkout happens to hold. */
export async function digestFile(filePath: string) {
    let contents = normalizeContent(await fs.readFile(filePath));
    return { size: contents.length, sha256: crypto.createHash("sha256").update(contents).digest("hex") };
}

export async function buildManifest(repoPath: string) {
    let files: Manifest["files"] = [];
    for (let relativePath of await listRepoFiles(repoPath)) {
        let digest = await digestFile(path.join(repoPath, relativePath));
        files.push({ path: relativePath, size: digest.size, sha256: digest.sha256 });
    }
    return { version: MANIFEST_VERSION, files };
}

/** Sorted keys and a trailing newline, so the same tree always produces the same bytes to sign. */
export function formatManifest(manifest: Manifest) {
    return JSON.stringify(manifest, undefined, 4) + "\n";
}
