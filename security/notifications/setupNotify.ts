import { parseWebhookFile } from "./discord";
import { ensureRemoteWebhook, REPLACE_KEYWORD } from "./remoteWebhook";
import { describeHost, THIS_MACHINE } from "../helpers/remoteSSH";

const USAGE = `Usage: yarn setupnotify [host] <discord-webhook-url> [${REPLACE_KEYWORD}]

With no host it sets the webhook up on this machine.`;

function parseArgs(argv: string[]) {
    let replace = argv.includes(REPLACE_KEYWORD);
    let positional = argv.filter(arg => arg !== REPLACE_KEYWORD);
    if (!positional.length || positional.length > 2) {
        throw new Error(
            `Expected a webhook URL, and optionally a host before it, was ${positional.length}`
            + ` argument(s): ${positional.join(" ") || "(none)"}\n${USAGE}`
        );
    }
    // The webhook url is the last one, so whatever comes before it is the host. Without one this
    // machine is the target.
    let webhookURL = positional[positional.length - 1];
    let host = positional.length > 1 && positional[0] || THIS_MACHINE;
    // Validates the URL shape up front, so we never go anywhere with a bad webhook.
    parseWebhookFile({ contents: webhookURL, sourceName: "the command line" });
    return { host, webhookURL, replace };
}

async function main() {
    let { host, webhookURL, replace } = parseArgs(process.argv.slice(2));
    let { outcome, filePath } = await ensureRemoteWebhook({ host, webhookURL, replace });
    if (outcome === "unchanged") {
        console.log(`${describeHost(host)} already has this exact webhook in ${filePath}, nothing to do.`);
        return;
    }
    if (outcome === "replaced") {
        console.log(`Replaced the webhook on ${describeHost(host)} and notified the old one.`);
    }
    console.log(`Wrote ${filePath} on ${describeHost(host)} (mode 600), and confirmed on the new webhook.`);
}

main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
