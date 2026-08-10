import { DEFAULT_WEBHOOK_FILE_PATH, formatWebhookFile, parseWebhookFile, redactWebhookURL, sendToWebhookURL } from "./discord";
import { readRemoteFile, writeRemoteFile } from "../helpers/remoteSSH";

export const REPLACE_KEYWORD = "replace";
const UNPARSEABLE_LABEL = "(unparseable)";

/** Puts a webhook on a remote host, refusing to clobber a different existing one unless asked.
    Returns what happened, so callers can decide whether to keep going. */
export async function ensureRemoteWebhook(config: {
    host: string;
    webhookURL: string;
    replace: boolean;
    filePath?: string;
}) {
    let { host, webhookURL, replace } = config;
    let filePath = config.filePath || DEFAULT_WEBHOOK_FILE_PATH;

    let replacedURL = "";
    let existingContents = await readRemoteFile({ host, filePath });
    if (existingContents) {
        // A corrupt existing file still counts as a conflict, so "replace" can repair it instead
        // of the setup dead ending on a parse error.
        let existingURL = UNPARSEABLE_LABEL;
        try {
            existingURL = parseWebhookFile({ contents: existingContents, sourceName: `${host}:${filePath}` });
        } catch (e) {
            console.error(`${host}:${filePath} exists but could not be parsed. ${e}`);
        }
        if (existingURL === webhookURL) {
            return { outcome: "unchanged" as const, filePath };
        }
        if (!replace) {
            throw new Error(
                `Expected no conflicting webhook on ${host}, but ${filePath} already holds a different one.\n`
                + `Existing: ${existingURL}\n`
                + `New:      ${webhookURL}\n`
                + `Pass "${REPLACE_KEYWORD}" to overwrite it.`
            );
        }
        replacedURL = existingURL;
    }

    await writeRemoteFile({
        host,
        filePath,
        contents: formatWebhookFile(webhookURL),
        fileMode: "600",
        directoryMode: "700",
    });

    let writtenContents = await readRemoteFile({ host, filePath });
    if (!writtenContents) {
        throw new Error(`Expected ${filePath} to exist on ${host} after writing, no such file exists`);
    }
    let writtenURL = parseWebhookFile({ contents: writtenContents, sourceName: `${host}:${filePath}` });
    if (writtenURL !== webhookURL) {
        throw new Error(`Expected ${host}:${filePath} to hold the new webhook, was ${writtenURL}`);
    }

    if (replacedURL && replacedURL !== UNPARSEABLE_LABEL) {
        // The new webhook is redacted, so this channel can identify the replacement without
        // receiving a webhook it could post to.
        try {
            await sendToWebhookURL({
                webhookURL: replacedURL,
                message: `**portsecure**: the Discord webhook for \`${host}\` was replaced with`
                    + ` \`${redactWebhookURL(webhookURL)}\`.`
                    + ` This channel will stop receiving notifications for that host.`,
            });
        } catch (e) {
            // The replacement already happened, so a dead old webhook must not fail the setup.
            console.error(`Could not notify the old webhook that it was replaced. ${e}`);
        }
    }

    // Failing here means the file is in place but the webhook itself does not work, which is
    // exactly what the operator needs to hear about.
    await sendToWebhookURL({
        webhookURL,
        message: `**portsecure**: notifications are now configured for \`${host}\`.`
            + ` This channel will receive its security notifications.`,
    });

    return { outcome: replacedURL && "replaced" as const || "created" as const, filePath };
}
