import os from "os";
import { sendDiscordNotification } from "../../notifications/discord";

let hostLabelValue = "";

export function setHostLabel(value: string) {
    hostLabelValue = value;
}

export function log(message: string) {
    console.log(`${new Date().toISOString()} portsecure: ${message}`);
}

// DO NOT add new calls to this. Every message goes to a real Discord server someone reads, so a
// notification is only ever added when the user explicitly asks for that specific case. Startup,
// success, errors, retries and recoveries all belong in log() instead. The complete list of cases
// that are allowed to notify is at the top of daemon.ts.
export async function notify(message: string) {
    try {
        await sendDiscordNotification(`**portsecure [${hostLabelValue || os.hostname()}]**: ${message}`);
    } catch (e) {
        // A failed notification must never take the daemon down, the local log is the fallback.
        log(`Failed to send Discord notification. ${e}`);
    }
}
