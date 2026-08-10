import crypto from "crypto";
import fs from "fs/promises";
import { spawnPromise } from "../../helpers/spawn";
import { AUTH_LOG_PATH } from "./paths";
import { log } from "./notify";
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
            log(`A refused attempt named no key, so nothing is being revoked for it: ${entries[0].line}`);
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
            log(`No auth log to read: ${AUTH_LOG_PATH} is unreadable and journalctl exited ${result.status}`);
            return "";
        }
        return result.stdout;
    }
    try {
        let stats = await handle.stat();
        let head = Buffer.alloc(Math.min(SIGNATURE_LENGTH, stats.size));
        await handle.read(head, 0, head.length, 0);
        let signature = crypto.createHash("sha256").update(head).digest("hex");

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
