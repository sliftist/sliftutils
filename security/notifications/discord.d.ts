export declare const DEFAULT_WEBHOOK_FILE_PATH = "/etc/portsecure/discord-webhook";
/** Pulls the webhook URL out of webhook file contents. `sourceName` only appears in errors, so
    callers can name a remote path. */
export declare function parseWebhookFile(config: {
    contents: string;
    sourceName: string;
}): string;
/** Keeps the id and both ends of the token, so a reader can confirm which webhook replaced theirs
    without receiving one they could post to. */
export declare function redactWebhookURL(webhookURL: string): string;
export declare function formatWebhookFile(webhookURL: string): string;
/** When the message was sent, in the sending machine's own time zone. Discord shows when it
    received something, which is not the same thing when a machine has been offline or a send has
    been retried, and the zone matters when the machines are not all in one place. */
export declare function messageTimestamp(now: Date): string;
/** Sends to an explicit webhook URL, for tooling that acts on a webhook before (or instead of)
    configureDiscordNotifications - setup, migrations, connectivity checks. */
export declare function sendToWebhookURL(config: {
    webhookURL: string;
    message: string;
}): Promise<void>;
/** Must be called once on startup, before any notification is sent. Aborts the process if the
    webhook file is missing or invalid, then re-checks the file on an interval and warns the old
    webhook whenever it changes. */
export declare function configureDiscordNotifications(config?: {
    filePath?: string;
    checkInterval?: number;
}): Promise<{
    filePath: string;
    checkInterval: number;
}>;
export declare function sendDiscordNotification(message: string): Promise<void>;
/** Whether notifications are set up in this process. For code that may run outside the daemon,
    where sending is worth doing if it can be and not worth failing over if it cannot. */
export declare function areDiscordNotificationsConfigured(): boolean;
export declare function stopDiscordNotifications(): void;
