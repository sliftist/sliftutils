import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

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

/** Adds addresses to a key's from= list, leaving the rest of the line exactly as it was. Returns
    which addresses were actually new, so a caller can report only what it changed.

    A key with no from= at all is left alone: adding one would silently restrict a key that is
    currently unrestricted, which is a different decision than the one being made here. */
export function allowAddresses(keyLine: string, addresses: string[]) {
    let list = keyRestrictionList(keyLine);
    if (!list) {
        return { keyLine, added: [] as string[] };
    }
    let allowed = list;
    let added = addresses.filter(address => address && !allowed.includes(address));
    if (!added.length) {
        return { keyLine, added };
    }
    return {
        keyLine: keyLine.replace(/from="[^"]*"/, `from="${[...allowed, ...added].join(",")}"`),
        added,
    };
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

/** The shortest thing that still identifies a key to a person: the comment it carries, which is
    usually user@machine, and otherwise the tail of the key itself. For the first line of a
    notification, where there is only room for the one thing that matters. */
export function keyNiceName(keyLine: string) {
    let parts = keyLine.trim().split(/\s+/);
    let typeIndex = parts.findIndex(part => /^(ssh-|ecdsa-|sk-)/.test(part));
    if (typeIndex < 0) {
        return keyLine.slice(0, 20);
    }
    let comment = parts.slice(typeIndex + 2).join(" ");
    return comment || `...${(parts[typeIndex + 1] || "").slice(-8)}`;
}

/** What a set of keys has to satisfy before it is worth signing, as a list of complaints.

    Every key needs a from=, because an unrestricted key can never be caught being used from the
    wrong place, and being caught is the only thing that triggers a revocation.

    No two keys may allow the same addresses, because that is one person holding two keys: revoking
    one of them leaves the other working, so the revocation achieves nothing. */
export function findKeyProblems(keys: string[]) {
    let problems: string[] = [];
    let byRestriction = new Map<string, string[]>();
    for (let key of keys) {
        let restriction = keyRestrictionList(key);
        if (!restriction) {
            problems.push(`no from= restriction, so it can be used from anywhere:\n      ${summarizeKey(key)}`);
            continue;
        }
        // Sorted, so the same addresses written in a different order still count as the same.
        let identity = [...restriction].sort().join(",");
        byRestriction.set(identity, [...(byRestriction.get(identity) || []), key]);
    }
    for (let [restriction, sharing] of byRestriction) {
        if (sharing.length < 2) {
            continue;
        }
        problems.push(
            `${sharing.length} keys allow exactly the same addresses (${restriction}), which is one`
            + ` person holding more than one key:\n`
            + sharing.map(key => `      ${summarizeKey(key)}`).join("\n")
        );
    }
    return problems;
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
