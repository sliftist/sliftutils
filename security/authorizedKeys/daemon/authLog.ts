import crypto from "crypto";
import { watch } from "fs";
import fs from "fs/promises";
import path from "path";
import { spawnPromise } from "../../helpers/spawn";
import { AUTH_LOG_PATH } from "./paths";
import { getState, saveState } from "./state";
import { Attempt } from "./revocation";

// sshd says an attempt was refused in one line and names the key in another, both for the same
// connection, so they are tied together by the process id the log puts on every line.
const REFUSED = /Authentication tried for (\S+) with correct key but not from a permitted host \(host=([^,]*), ip=([^,]*), required=([^)]*)\)/;
const FAILED_KEY = /Failed publickey for (\S+) from (\S+) port (\d+) ssh2: \S+ (SHA256:[A-Za-z0-9+/=]+)/;
const PROCESS_ID = /(?:sshd|sshd-session)\[(\d+)\]/;
// Enough of the head of the file to notice it was rotated out from under us.
const SIGNATURE_LENGTH = 512;

export type RefusedAttempt = { fingerprint: string; attempt: Attempt };

/** Pairs each refusal with the fingerprint sshd logged for the same connection. A refusal we
    cannot tie to a key is dropped: revoking the wrong key would lock out the wrong person. */
export function parseAuthLog(contents: string) {
    let refusals = new Map<string, { user: string; ip: string; required: string; line: string }[]>();
    let fingerprints = new Map<string, { fingerprint: string; port: string }>();
    for (let line of contents.split("\n")) {
        let processMatch = line.match(PROCESS_ID);
        if (!processMatch) {
            continue;
        }
        let processId = processMatch[1];
        let refused = line.match(REFUSED);
        if (refused) {
            let existing = refusals.get(processId) || [];
            existing.push({ user: refused[1], ip: refused[3], required: refused[4], line: line.trim() });
            refusals.set(processId, existing);
            continue;
        }
        let failed = line.match(FAILED_KEY);
        if (failed) {
            fingerprints.set(processId, { fingerprint: failed[4], port: failed[3] });
        }
    }

    let attempts: RefusedAttempt[] = [];
    for (let [processId, entries] of refusals) {
        let key = fingerprints.get(processId);
        if (!key) {
            console.log(`A refused attempt named no key, so nothing is being revoked for it: ${entries[0].line}`);
            continue;
        }
        for (let entry of entries) {
            attempts.push({
                fingerprint: key.fingerprint,
                attempt: {
                    ip: entry.ip,
                    user: entry.user,
                    port: key.port,
                    required: entry.required,
                    line: entry.line,
                },
            });
        }
    }
    return attempts;
}

/** Only what has been written since last time. A rotated file starts again from the beginning,
    and a file that only grew is read from where we stopped. */
export async function readNewAuthLog() {
    let state = getState();
    let handle;
    try {
        handle = await fs.open(AUTH_LOG_PATH, "r");
    } catch (e) {
        // Some machines only keep this in the journal.
        let result = await spawnPromise({
            command: "journalctl",
            args: ["-u", "ssh", "-u", "sshd", "--no-pager", "--since", "-10min"],
        });
        if (result.status !== 0) {
            console.log(`No auth log to read: ${AUTH_LOG_PATH} is unreadable and journalctl exited ${result.status}`);
            return "";
        }
        return result.stdout;
    }
    try {
        let stats = await handle.stat();
        let head = Buffer.alloc(Math.min(SIGNATURE_LENGTH, stats.size));
        await handle.read(head, 0, head.length, 0);
        let signature = crypto.createHash("sha256").update(head).digest("hex");

        if (!state.authLogSignature) {
            // First time we have ever looked. Start from the end: the log holds history from
            // before this machine watched it, and revoking keys over refusals nobody was watching
            // for could take away access that is still in use.
            state.authLogOffset = stats.size;
            state.authLogSignature = signature;
            await saveState();
            console.log(`Watching ${AUTH_LOG_PATH} from its current end, ${stats.size} bytes in`);
            return "";
        }
        let offset = state.authLogOffset;
        if (signature !== state.authLogSignature || stats.size < offset) {
            // Rotated, or replaced. Everything in the new file is new.
            offset = 0;
        }
        if (stats.size === offset) {
            return "";
        }
        let contents = Buffer.alloc(stats.size - offset);
        await handle.read(contents, 0, contents.length, offset);
        state.authLogOffset = stats.size;
        state.authLogSignature = signature;
        await saveState();
        return contents.toString("utf8");
    } finally {
        await handle.close();
    }
}

/** Reacts when sshd writes, rather than on a timer. A refused login is worth acting on at once,
    and nothing is gained by hearing about it up to a minute later.

    The directory is watched rather than the file. A watch on the file follows the inode, so it
    goes silent the moment the log is rotated out from under it, while the directory keeps
    reporting both the writes and the rotation. */
export function watchAuthLog(onChange: () => Promise<void>) {
    let running = false;
    let againWhenDone = false;
    let run = async () => {
        // One at a time. Whatever arrives mid run is covered by a single further pass, rather than
        // by however many events happened to fire.
        if (running) {
            againWhenDone = true;
            return;
        }
        running = true;
        try {
            await onChange();
        } catch (e) {
            console.log(`Reading ${AUTH_LOG_PATH} failed. ${e}`);
        }
        running = false;
        if (againWhenDone) {
            againWhenDone = false;
            void run();
        }
    };

    let name = path.basename(AUTH_LOG_PATH);
    try {
        watch(path.dirname(AUTH_LOG_PATH), (type, changed) => {
            if (changed === name) {
                void run();
            }
        });
        console.log(`Watching ${AUTH_LOG_PATH} for refused logins`);
    } catch (e) {
        console.log(`Cannot watch ${AUTH_LOG_PATH}, so refused logins will not be noticed. ${e}`);
    }
    return run;
}
