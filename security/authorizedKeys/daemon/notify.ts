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
/** A headline and the rest.

    The headline is all a phone shows. It gets the whole preview to itself: no product name, no
    host, no timestamp in front of it, because a person glancing at their lock screen needs to read
    what happened, not which machine said it or when. Those go at the end, where they are there for
    whoever opens the message and out of the way of whoever does not. */
export async function notify(headline: string, body: string) {
    let full = `**${headline}**\n\n${body}\n\n${hostLabelValue || os.hostname()}`;
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
