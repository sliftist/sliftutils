import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

// PORTED CODE: security/authorizedKeys/daemon/portsecureDaemon.js contains a plain JS port of normalizeKeys,
// summarizeKey and readRepoKeys, so it can resolve the same keys with no dependencies. The two
// must agree on which keys a repo produces - if you change one, make the matching change in the
// other.

export function normalizeKeys(contents: string) {
    return contents.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
}

/** The fingerprint ssh itself reports for a key, which is what the sshd log names and therefore
    what a revocation is keyed by. Returns "" for a line that holds no key. */
export function keyFingerprint(keyLine: string) {
    let parts = keyLine.trim().split(/\s+/);
    let typeIndex = parts.findIndex(part => /^(ssh-|ecdsa-|sk-)/.test(part));
    let blob = typeIndex >= 0 && parts[typeIndex + 1] || "";
    if (!blob) {
        return "";
    }
    return "SHA256:" + crypto.createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "");
}

export const NO_RESTRICTION = "ANY ADDRESS (no from= restriction)";

/** The addresses a key may be used from, one by one, or undefined when the key carries no from=
    at all. Undefined and an empty list are very different things, so they stay distinguishable. */
export function keyRestrictionList(keyLine: string) {
    let match = keyLine.match(/from="([^"]*)"/);
    if (!match) {
        return undefined;
    }
    return match[1].split(",").map(entry => entry.trim()).filter(entry => entry);
}

/** The addresses a key may be used from, which is the part of an authorized_keys line that
    decides how much a stolen key is worth. A key with no restriction says so loudly. */
export function keyRestriction(keyLine: string) {
    let list = keyRestrictionList(keyLine);
    if (!list) {
        return NO_RESTRICTION;
    }
    return list.join(",");
}

/** Enough to recognise whose key this is without printing the whole blob. */
export function summarizeKey(keyLine: string) {
    let parts = keyLine.trim().split(/\s+/);
    let typeIndex = parts.findIndex(part => /^(ssh-|ecdsa-|sk-)/.test(part));
    if (typeIndex < 0) {
        return keyLine.slice(0, 60);
    }
    let type = parts[typeIndex];
    let blob = parts[typeIndex + 1] || "";
    let comment = parts.slice(typeIndex + 2).join(" ");
    return `${type} ...${blob.slice(-12)}${comment && ` ${comment}` || ""}`;
}

/** Reads the authorized keys a repo checkout wants applied. Prefers a top level authorized_keys
    file and otherwise concatenates every .pub at the top level. */
export async function readRepoKeys(repoPath: string) {
    let combinedPath = path.join(repoPath, "authorized_keys");
    let entries = await fs.readdir(repoPath);
    if (entries.includes("authorized_keys")) {
        return normalizeKeys(await fs.readFile(combinedPath, "utf8"));
    }
    let pubFiles = entries.filter(name => name.endsWith(".pub")).sort();
    if (!pubFiles.length) {
        throw new Error(`Expected authorized_keys or at least one .pub file in ${repoPath}, found neither`);
    }
    let keys: string[] = [];
    for (let name of pubFiles) {
        keys.push(...normalizeKeys(await fs.readFile(path.join(repoPath, name), "utf8")));
    }
    return keys;
}
