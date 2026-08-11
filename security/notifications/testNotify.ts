import fs from "fs/promises";
import os from "os";
import { DEFAULT_WEBHOOK_FILE_PATH, parseWebhookFile, sendToWebhookURL } from "./discord";
import { readRemoteFile } from "../helpers/remoteSSH";

const USAGE = `Usage: yarn testnotify [host]

Sends one message to a webhook, to prove it works. With no host it uses this machine's webhook at
${DEFAULT_WEBHOOK_FILE_PATH}. With a host it reads that host's webhook and sends to that instead,
which is how you check a machine you have just set up.`;

export async function main() {
    let argv = process.argv.slice(2);
    if (argv.length > 1) {
        throw new Error(`Expected at most a host, was ${argv.length} argument(s)\n${USAGE}`);
    }
    let host = argv[0];

    let contents: string | undefined;
    if (host) {
        contents = await readRemoteFile({ host, filePath: DEFAULT_WEBHOOK_FILE_PATH });
        if (!contents) {
            throw new Error(
                `Expected a webhook at ${DEFAULT_WEBHOOK_FILE_PATH} on ${host}, no such file exists.\n`
                + `Set it up with:\n  yarn setupnotify ${host} <discord-webhook-url>`
            );
        }
    } else {
        try {
            contents = await fs.readFile(DEFAULT_WEBHOOK_FILE_PATH, "utf8");
        } catch (e) {
            throw new Error(
                `Expected a webhook at ${DEFAULT_WEBHOOK_FILE_PATH} on this machine, ${e}\n`
                + `Name a host to use that host's webhook instead.\n${USAGE}`
            );
        }
    }

    let source = host || os.hostname();
    let webhookURL = parseWebhookFile({ contents, sourceName: `${source}:${DEFAULT_WEBHOOK_FILE_PATH}` });
    // Said plainly, so nobody reading the channel later has to work out whether it was real.
    await sendToWebhookURL({
        webhookURL,
        message: `**portsecure test**: this is a test message, nothing has happened.`
            + ` Sent with \`yarn testnotify\` for the webhook \`${source}\` uses.`,
    });
    console.log(`Sent a test message to the webhook ${source} uses.`);
}
