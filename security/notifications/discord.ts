import fs from "fs/promises";

// PORTED CODE: security/authorizedKeys/daemon/portsecureDaemon.js embeds a hand port of this file in plain JS, so the
// daemon can run with no dependencies. The two are expected to behave identically - if you change
// one, make the matching change in the other.

export const DEFAULT_WEBHOOK_FILE_PATH = "/etc/portsecure/discord-webhook";
const DEFAULT_CHECK_INTERVAL = 5 * 60 * 1000;
const VALID_WEBHOOK_PREFIXES = [
    "https://discord.com/api/webhooks/",
    "https://discordapp.com/api/webhooks/",
    "https://canary.discord.com/api/webhooks/",
];
const DISCORD_MESSAGE_LIMIT = 2000;
const MAX_ERROR_BODY_LENGTH = 500;
const MAX_SEND_ATTEMPTS = 3;
const REDACTED_TOKEN_VISIBLE = 8;
const DEFAULT_RATE_LIMIT_WAIT = 2 * 1000;

let notificationState: {
    filePath: string;
    webhookURL: string;
    checkTimer: NodeJS.Timeout;
} | undefined;

// Discord webhooks are rate limited (roughly 5 requests per 2 seconds), so every send
// goes through one chain instead of racing.
let sendChain: Promise<unknown> = Promise.resolve();

/** Pulls the webhook URL out of webhook file contents. `sourceName` only appears in errors, so
    callers can name a remote path. */
export function parseWebhookFile(config: { contents: string; sourceName: string }) {
    let { contents, sourceName } = config;
    let lines = contents.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    let webhookURL = lines[0];
    if (!webhookURL) {
        throw new Error(`Expected a Discord webhook URL in ${sourceName}, the file has no usable lines`);
    }
    if (!VALID_WEBHOOK_PREFIXES.some(prefix => webhookURL.startsWith(prefix))) {
        throw new Error(
            `Expected a Discord webhook URL starting with one of ${VALID_WEBHOOK_PREFIXES.join(", ")}, `
            + `was ${webhookURL.slice(0, MAX_ERROR_BODY_LENGTH)} (in ${sourceName})`
        );
    }
    return webhookURL;
}

/** Keeps the id and both ends of the token, so a reader can confirm which webhook replaced theirs
    without receiving one they could post to. */
export function redactWebhookURL(webhookURL: string) {
    let separatorIndex = webhookURL.lastIndexOf("/");
    let base = webhookURL.slice(0, separatorIndex + 1);
    let token = webhookURL.slice(separatorIndex + 1);
    if (token.length <= REDACTED_TOKEN_VISIBLE * 2) {
        // Too short to show both ends without giving away the whole token.
        return `${base}${token.slice(0, REDACTED_TOKEN_VISIBLE)}...`;
    }
    return `${base}${token.slice(0, REDACTED_TOKEN_VISIBLE)}...${token.slice(-REDACTED_TOKEN_VISIBLE)}`;
}

export function formatWebhookFile(webhookURL: string) {
    return `# portsecure Discord webhook. First non-comment line is used.\n${webhookURL}\n`;
}

async function readWebhookFile(filePath: string) {
    let contents;
    try {
        contents = await fs.readFile(filePath, "utf8");
    } catch (e) {
        throw new Error(`Expected a readable Discord webhook file at ${filePath}, ${e}`);
    }
    return parseWebhookFile({ contents, sourceName: filePath });
}

/** When the message was sent, in the sending machine's own time zone. Discord shows when it
    received something, which is not the same thing when a machine has been offline or a send has
    been retried, and the zone matters when the machines are not all in one place. */
export function messageTimestamp(now: Date) {
    let date = now.toLocaleDateString("en-CA");
    let time = now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
        timeZoneName: "short",
    });
    return `${date} ${time}`;
}

async function postToWebhook(webhookURL: string, message: string) {
    // Stamped once rather than per attempt, so a retry says when the thing happened rather than
    // when we last managed to get it out. At the end, because the first line of a message is the
    // notification preview and a timestamp there would spend it saying nothing.
    let content = `${message} · \`${messageTimestamp(new Date())}\``;
    if (content.length > DISCORD_MESSAGE_LIMIT) {
        content = content.slice(0, DISCORD_MESSAGE_LIMIT - 3) + "...";
    }
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
        let response = await fetch(webhookURL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
        });
        if (response.ok) {
            return;
        }
        let body = (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH);
        if (response.status === 429 && attempt < MAX_SEND_ATTEMPTS) {
            let retryAfter = Number(response.headers.get("retry-after"));
            let waitTime = retryAfter && retryAfter * 1000 || DEFAULT_RATE_LIMIT_WAIT;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
        }
        throw new Error(
            `Expected a 2xx response from the Discord webhook, was ${response.status} ${response.statusText}, body ${body}`
        );
    }
}

function queueSend(webhookURL: string, message: string) {
    let send = () => postToWebhook(webhookURL, message);
    let result = sendChain.then(send, send);
    sendChain = result.catch(() => undefined);
    return result;
}

/** Sends to an explicit webhook URL, for tooling that acts on a webhook before (or instead of)
    configureDiscordNotifications - setup, migrations, connectivity checks. */
export function sendToWebhookURL(config: { webhookURL: string; message: string }) {
    return queueSend(config.webhookURL, config.message);
}

async function checkWebhookFileChanged() {
    let state = notificationState;
    if (!state) {
        return;
    }
    let newWebhookURL;
    try {
        newWebhookURL = await readWebhookFile(state.filePath);
    } catch (e) {
        console.error(`portsecure: Discord webhook file is no longer readable, still using the loaded webhook. ${e}`);
        return;
    }
    if (newWebhookURL === state.webhookURL) {
        return;
    }
    // Warn the old channel first, with the new webhook redacted, so a stolen old webhook does not
    // hand the attacker a usable new one.
    try {
        await queueSend(
            state.webhookURL,
            `**portsecure**: **NOTIFICATIONS ARE MOVING TO ANOTHER CHANNEL**`
            + `\n\nThis channel stops receiving them now. If that was not you, somebody with access`
            + ` to this machine just redirected its alerts.`
            + `\n\nnew webhook: \`${redactWebhookURL(newWebhookURL)}\``
            + `\nset in: \`${state.filePath}\``
        );
    } catch (e) {
        console.error(`portsecure: failed to warn the old Discord webhook about the change. ${e}`);
    }
    state.webhookURL = newWebhookURL;
}

/** Must be called once on startup, before any notification is sent. Aborts the process if the
    webhook file is missing or invalid, then re-checks the file on an interval and warns the old
    webhook whenever it changes. */
export async function configureDiscordNotifications(config?: {
    filePath?: string;
    checkInterval?: number;
}) {
    if (notificationState) {
        throw new Error(`Expected configureDiscordNotifications to be called once, was called again (already using ${notificationState.filePath})`);
    }
    let filePath = config?.filePath || DEFAULT_WEBHOOK_FILE_PATH;
    let checkInterval = config?.checkInterval || DEFAULT_CHECK_INTERVAL;
    let webhookURL;
    try {
        webhookURL = await readWebhookFile(filePath);
    } catch (e) {
        console.error(`portsecure: refusing to start without a valid Discord webhook file.\n${e}`);
        process.exit(1);
    }
    let checkTimer = setInterval(() => {
        checkWebhookFileChanged().catch(e => console.error(`portsecure: Discord webhook file check failed. ${e}`));
    }, checkInterval);
    // The check should never be the reason the process stays alive.
    checkTimer.unref();
    notificationState = { filePath, webhookURL, checkTimer };
    return { filePath, checkInterval };
}

// DO NOT add new calls to this. Every message goes to a real Discord server someone reads, so a
// notification is only ever added when the user explicitly asks for that specific case. Startup,
// success, errors, retries and recoveries all belong in a log instead.
export async function sendDiscordNotification(message: string) {
    let state = notificationState;
    if (!state) {
        throw new Error(`Expected configureDiscordNotifications to be called before sending, was called with message ${message.slice(0, MAX_ERROR_BODY_LENGTH)}`);
    }
    await queueSend(state.webhookURL, message);
}

export function stopDiscordNotifications() {
    if (!notificationState) {
        return;
    }
    clearInterval(notificationState.checkTimer);
    notificationState = undefined;
}
