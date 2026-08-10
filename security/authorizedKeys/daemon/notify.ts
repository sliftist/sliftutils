import os from "os";
import { sendDiscordNotification } from "../../notifications/discord";

let hostLabelValue = "";

export function setHostLabel(value: string) {
    hostLabelValue = value;
}

// DO NOT add new calls to this. Every message goes to a real Discord server someone reads, so a
// notification is only ever added when the user explicitly asks for that specific case. Startup,
// success, errors, retries and recoveries all belong in console.log instead. The complete list of
// cases that are allowed to notify is at the top of daemon.ts.
export async function notify(message: string) {
    let full = `**portsecure [${hostLabelValue || os.hostname()}]**: ${message}`;
    // Logged before it is sent, and whether or not it arrives, so the journal is a complete record
    // of what this machine had to say even when Discord is unreachable or the webhook is wrong.
    console.log(`Discord: ${full}`);
    try {
        await sendDiscordNotification(full);
    } catch (e) {
        // A failed notification must never take the daemon down, the local log is the fallback.
        console.log(`Failed to send the Discord notification above. ${e}`);
    }
}
