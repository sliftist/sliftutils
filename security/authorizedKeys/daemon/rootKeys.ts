import fs from "fs/promises";
import path from "path";
import { keyFingerprint, keyRestriction, keyRestrictionList, NO_RESTRICTION, summarizeKey } from "../authorizedKeys";
import { KEYS_HISTORY_PATH, ROOT_AUTHORIZED_KEYS } from "./paths";
import { notify } from "./notify";

const KEY_FILE_HEADER = "# Managed by portsecure. Manual changes are reverted and reported.";

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

/** Keys are matched by the key itself, not by the text of the line, so changing which addresses a
    key may be used from reads as that one key changing rather than as one key leaving and another
    arriving. A line we cannot read a key out of falls back to the whole line. */
function keyIdentity(keyLine: string) {
    return keyFingerprint(keyLine) || keyLine;
}

/** Which addresses a key gained or lost, rather than two long lists to compare by eye. Returns ""
    when the addresses did not change at all. Losing the from= altogether is the loudest case there
    is, so it is spelled out rather than shown as a list of removals. */
function describeAddressChange(config: { previousLine: string; currentLine: string }) {
    let { previousLine, currentLine } = config;
    let previous = keyRestrictionList(previousLine);
    let current = keyRestrictionList(currentLine);
    if (!previous && !current) {
        return "";
    }
    if (previous && !current) {
        return `          was ${previous.join(",")}\n          now ${NO_RESTRICTION}`;
    }
    if (!previous && current) {
        return `          was ${NO_RESTRICTION}\n          now restricted to ${current.join(",")}`;
    }
    let removed = (previous || []).filter(address => !(current || []).includes(address));
    let added = (current || []).filter(address => !(previous || []).includes(address));
    if (!removed.length && !added.length) {
        return "";
    }
    let lines = [
        ...removed.map(address => `          no longer allowed from ${address}`),
        ...added.map(address => `          now also allowed from ${address}`),
    ];
    lines.push(`          still allowed from ${(current || []).filter(address => !added.includes(address)).join(",") || "nothing"}`);
    return lines.join("\n");
}

export function describeKeyDifference(config: { before: string[]; after: string[] }) {
    let { before, after } = config;
    let beforeByKey = new Map(before.map(key => [keyIdentity(key), key]));
    let afterByKey = new Map(after.map(key => [keyIdentity(key), key]));

    let lines: string[] = [];
    for (let [identity, keyLine] of afterByKey) {
        if (!beforeByKey.has(identity)) {
            lines.push(`+ added   ${summarizeKey(keyLine)}\n          from ${keyRestriction(keyLine)}`);
        }
    }
    for (let [identity, keyLine] of beforeByKey) {
        if (!afterByKey.has(identity)) {
            lines.push(`- removed ${summarizeKey(keyLine)}\n          from ${keyRestriction(keyLine)}`);
        }
    }
    for (let [identity, previousLine] of beforeByKey) {
        let currentLine = afterByKey.get(identity);
        if (!currentLine || currentLine === previousLine) {
            continue;
        }
        let addressChange = describeAddressChange({ previousLine, currentLine });
        if (addressChange) {
            lines.push(`~ changed ${summarizeKey(currentLine)}\n${addressChange}`);
            continue;
        }
        lines.push(
            `~ changed ${summarizeKey(currentLine)}\n          from ${keyRestriction(currentLine)}\n`
            + `          its options or comment changed`
        );
    }
    if (!lines.length) {
        return "(no keys differ)";
    }
    return lines.join("\n");
}

export async function readAuthorizedKeysFile(filePath: string) {
    if (!await pathExists(filePath)) {
        return [];
    }
    let contents = await fs.readFile(filePath, "utf8");
    return contents.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
}

export async function writeAuthorizedKeysFile(config: { filePath: string; keys: string[] }) {
    let { filePath, keys } = config;
    let directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    // Written to a temporary file first, so an interrupted write can never leave root with a
    // truncated authorized_keys and no way back in.
    let temporaryPath = `${filePath}.portsecure-tmp`;
    await fs.writeFile(temporaryPath, `${KEY_FILE_HEADER}\n${keys.join("\n")}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
}

/** Keeps a copy of whatever is about to be overwritten, named for the moment it was replaced.
    Recovers a key that was clobbered by mistake, and doubles as the history of who had access.
    The very first archive is the most valuable one, since it holds the keys from before portsecure
    took the file over. */
export async function archiveAuthorizedKeys(config: { filePath: string; reason: string }) {
    let { filePath, reason } = config;
    if (!await pathExists(filePath)) {
        return "";
    }
    let contents = await fs.readFile(filePath, "utf8");
    await fs.mkdir(KEYS_HISTORY_PATH, { recursive: true, mode: 0o700 });
    await fs.chmod(KEYS_HISTORY_PATH, 0o700);
    let stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let archivePath = path.join(KEYS_HISTORY_PATH, `${stamp}-${reason}.authorized_keys`);
    let attempt = 1;
    while (await pathExists(archivePath)) {
        attempt++;
        archivePath = path.join(KEYS_HISTORY_PATH, `${stamp}-${reason}-${attempt}.authorized_keys`);
    }
    await fs.writeFile(archivePath, contents, { mode: 0o600 });
    return archivePath;
}

/** Puts the allowed keys back in place if anything else changed them. */
export async function enforceRootKeys(config: { keys: string[]; reason: string }) {
    let { keys, reason } = config;
    if (!keys.length) {
        // No sources, or none of them readable. Writing an empty file would lock everyone out, so
        // whatever access is already in place stays exactly as it is.
        console.log(`No keys came from any source, leaving ${ROOT_AUTHORIZED_KEYS} as it is`);
        return;
    }
    let currentKeys = await readAuthorizedKeysFile(ROOT_AUTHORIZED_KEYS);
    let matches = currentKeys.length === keys.length && currentKeys.every((key, index) => key === keys[index]);
    if (matches) {
        return;
    }
    let archivePath = await archiveAuthorizedKeys({ filePath: ROOT_AUTHORIZED_KEYS, reason });
    await writeAuthorizedKeysFile({ filePath: ROOT_AUTHORIZED_KEYS, keys });
    let difference = describeKeyDifference({ before: currentKeys, after: keys });
    let archiveNote = archivePath && `\nThe previous file is kept at \`${archivePath}\`.` || "";
    if (reason === "repo") {
        await notify(`root's authorized_keys was updated from the keys repo.\n\`\`\`\n${difference}\n\`\`\`${archiveNote}`);
        return;
    }
    await notify(
        `root's authorized_keys was changed outside portsecure and has been reverted to the keys repo.`
        + `\n\`\`\`\n${difference}\n\`\`\`${archiveNote}`
    );
}
