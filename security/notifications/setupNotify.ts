import { parseWebhookFile } from "./discord";
import { ensureRemoteWebhook, REPLACE_KEYWORD } from "./remoteWebhook";

const USAGE = `Usage: yarn setupnotify <host> <discord-webhook-url> [${REPLACE_KEYWORD}]`;

function parseArgs(argv: string[]) {
    let replace = argv.includes(REPLACE_KEYWORD);
    let positional = argv.filter(arg => arg !== REPLACE_KEYWORD);
    if (positional.length !== 2) {
        throw new Error(`Expected a host and a webhook URL, was ${positional.length} argument(s): ${positional.join(" ") || "(none)"}\n${USAGE}`);
    }
    let [host, webhookURL] = positional;
    // Validates the URL shape up front, so we never ssh anywhere with a bad webhook.
    parseWebhookFile({ contents: webhookURL, sourceName: "the command line" });
    return { host, webhookURL, replace };
}

export async function main() {
    let { host, webhookURL, replace } = parseArgs(process.argv.slice(2));
    let { outcome, filePath } = await ensureRemoteWebhook({ host, webhookURL, replace });
    if (outcome === "unchanged") {
        console.log(`${host} already has this exact webhook in ${filePath}, nothing to do.`);
        return;
    }
    if (outcome === "replaced") {
        console.log(`Replaced the webhook on ${host} and notified the old one.`);
    }
    console.log(`Wrote ${filePath} on ${host} (mode 600), and confirmed on the new webhook.`);
}
