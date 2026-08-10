import fs from "fs/promises";
import { spawnPromise } from "../../helpers/spawn";
import { AUTH_LOG_PATH } from "./paths";

// Taking a key out of authorized_keys only stops the next login. Whoever is already connected with
// it stays connected for as long as they like, which would make revoking a key that is being
// actively misused close to pointless.
//
// sshd names the key it accepted and the process handling that connection on the same line, so the
// sessions belonging to one key can be ended without touching anyone else's.
const ACCEPTED = /(?:sshd|sshd-session)\[(\d+)\]:\s+Accepted publickey for (\S+) from (\S+) port (\d+) ssh2: \S+ (SHA256:[A-Za-z0-9+/=]+)/;

export type KeySession = { processId: number; user: string; ip: string; port: string };

export function parseAcceptedSessions(contents: string, fingerprint: string) {
    let sessions: KeySession[] = [];
    for (let line of contents.split("\n")) {
        let match = line.match(ACCEPTED);
        if (!match || match[5] !== fingerprint) {
            continue;
        }
        sessions.push({ processId: Number(match[1]), user: match[2], ip: match[3], port: match[4] });
    }
    return sessions;
}

/** Process ids are reused, so one is only killed when it is still an ssh session. Killing whatever
    happens to hold that number now would be far worse than missing a session. */
async function isSSHSession(processId: number) {
    try {
        let name = await fs.readFile(`/proc/${processId}/comm`, "utf8");
        return name.trim().startsWith("sshd");
    } catch (e) {
        return false;
    }
}

/** The whole log, not only what is new, because the session being ended may have been established
    long before the key was misused. */
async function readWholeAuthLog() {
    try {
        return await fs.readFile(AUTH_LOG_PATH, "utf8");
    } catch (e) {
        let result = await spawnPromise({
            command: "journalctl",
            args: ["-u", "ssh", "-u", "sshd", "--no-pager", "--since", "-30days"],
        });
        return result.status === 0 && result.stdout || "";
    }
}

/** Ends every live session that authenticated with this key. Returns what was ended, so the
    revocation can say so rather than leaving it to be discovered. */
export async function endSessionsUsingKey(fingerprint: string) {
    let ended: KeySession[] = [];
    for (let session of parseAcceptedSessions(await readWholeAuthLog(), fingerprint)) {
        if (session.processId <= 1 || session.processId === process.pid) {
            continue;
        }
        if (!await isSSHSession(session.processId)) {
            continue;
        }
        try {
            process.kill(session.processId, "SIGKILL");
            ended.push(session);
            console.log(`Ended ssh session ${session.processId} (${session.user} from ${session.ip}), it used ${fingerprint}`);
        } catch (e) {
            // Gone between looking and killing, which is the outcome we wanted anyway.
        }
    }
    return ended;
}

/** Whether this process is one connection. The listener is not a connection - it is the process
    that accepts them - so it is not a candidate here at all.

    Every openssh since 9.8 runs each connection as its own sshd-session. On older ones connections
    are named sshd too, and the listener is the one systemd started directly with -D. */
async function isConnectionProcess(processId: number) {
    let name: string;
    try {
        name = (await fs.readFile(`/proc/${processId}/comm`, "utf8")).trim();
    } catch (e) {
        return false;
    }
    if (name === "sshd-session") {
        return true;
    }
    if (name !== "sshd") {
        return false;
    }
    let commandLine = await fs.readFile(`/proc/${processId}/cmdline`, "utf8").catch(() => "");
    let parentId = Number((await fs.readFile(`/proc/${processId}/stat`, "utf8").catch(() => "")).split(") ")[1]?.split(" ")[1] || 0);
    return !commandLine.includes("-D") && parentId !== 1;
}

/** Disconnects every ssh session on the machine.

    Not only the ones using the key that was just taken away: a session that predates the key being
    removed is exactly as dangerous, and working out which sessions are still entitled to be here
    is guesswork. Anyone who still has access can reconnect in a second, and anyone who does not
    should not be here. */
export async function endAllSSHSessions() {
    let ended: number[] = [];
    for (let entry of await fs.readdir("/proc")) {
        let processId = Number(entry);
        if (!processId || processId <= 1 || processId === process.pid) {
            continue;
        }
        if (!await isConnectionProcess(processId)) {
            continue;
        }
        try {
            process.kill(processId, "SIGKILL");
            ended.push(processId);
        } catch (e) {
            // Gone between looking and killing, which is the outcome we wanted anyway.
        }
    }
    if (ended.length) {
        console.log(`Disconnected ${ended.length} ssh session(s): ${ended.join(", ")}`);
    }
    return ended;
}

export function describeAllEnded(ended: number[]) {
    if (!ended.length) {
        return " Nothing was connected.";
    }
    return ` Every ssh session on this machine was disconnected, ${ended.length} of them.`;
}

export function describeEndedSessions(ended: KeySession[]) {
    if (!ended.length) {
        return " Nothing was connected with it.";
    }
    return ` ${ended.length} live session(s) using it were killed: `
        + ended.map(session => `${session.user}@${session.ip}:${session.port}`).join(", ") + ".";
}
