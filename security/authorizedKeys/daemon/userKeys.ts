import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { summarizeKey } from "../authorizedKeys";
import { PASSWD_PATH, ROOT_AUTHORIZED_KEYS } from "./paths";
import { notify } from "./notify";
import { getState, saveState } from "./state";
import { readAuthorizedKeysFile } from "./rootKeys";

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

export async function listUserAuthorizedKeyFiles() {
    let entries: { name: string; filePath: string }[] = [];
    let passwd = await fs.readFile(PASSWD_PATH, "utf8");
    for (let line of passwd.split("\n")) {
        let fields = line.split(":");
        if (fields.length < 7) {
            continue;
        }
        let [name, , , , , home] = fields;
        if (!home || !await pathExists(home)) {
            continue;
        }
        let filePath = path.join(home, ".ssh", "authorized_keys");
        if (filePath === ROOT_AUTHORIZED_KEYS) {
            continue;
        }
        entries.push({ name, filePath });
    }
    return entries;
}

function hashKeys(keys: string[]) {
    return crypto.createHash("sha256").update(keys.join("\n")).digest("hex");
}

/** Seeds the per user hashes without reporting every existing file as a change. */
export async function seedUserKeys() {
    let state = getState();
    if (Object.keys(state.userKeyHashes).length) {
        return;
    }
    for (let entry of await listUserAuthorizedKeyFiles()) {
        state.userKeyHashes[entry.name] = hashKeys(await readAuthorizedKeysFile(entry.filePath));
    }
    await saveState();
}

/** Root is enforced elsewhere, every other account is watched and reported on. */
export async function checkOtherUserKeys() {
    let state = getState();
    let hashes: { [name: string]: string } = {};
    for (let entry of await listUserAuthorizedKeyFiles()) {
        let keys = await readAuthorizedKeysFile(entry.filePath);
        let hash = hashKeys(keys);
        hashes[entry.name] = hash;
        let previousHash = state.userKeyHashes[entry.name];
        if (previousHash === undefined || previousHash === hash) {
            continue;
        }
        await notify(`SSH KEYS CHANGED FOR USER ${entry.name}`,
            `Somebody changed who can log in as \`${entry.name}\`. portsecure does not manage that`
            + ` account, so the change was left alone. Who can log in as \`${entry.name}\` now:`
            + `\n\`\`\`\n${keys.map(summarizeKey).join("\n") || "(nobody, the file is now empty)"}\n\`\`\``
            + `\n${entry.filePath}`
        );
    }
    state.userKeyHashes = hashes;
    await saveState();
}
