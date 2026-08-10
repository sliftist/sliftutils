#!/usr/bin/env node
"use strict";

// portsecure authorized-keys daemon.
//
// Deliberately plain JavaScript with no dependencies beyond the Node built-ins, so it can be
// dropped onto any machine that has node and run with nothing installed alongside it.
//
// It owns root's authorized_keys: the contents come from a git repo, anything else is reverted,
// and password authentication is turned off so the repo is the only way in.
//
// The complete list of things that send a Discord message. Nothing else may be added to it
// without the user asking for that specific case - everything else goes to the log.
//   1. root's authorized_keys was changed outside portsecure, and was reverted.
//   2. root's authorized_keys was updated because the keys repo changed.
//   3. Another user's authorized_keys changed.
//   4. The keys repo history was rewritten.
//   5. The webhook file itself changed, reported to the webhook being replaced.

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const CONFIG_PATH = "/etc/portsecure/daemon.json";
const STATE_PATH = "/var/lib/portsecure/state.json";
// Locations the daemon owns. They are fixed rather than configurable, so every machine looks the
// same and the config file only carries what genuinely differs between them.
// One key and one checkout per source, at paths derived from the repo url rather than configured.
const REPO_KEYS_DIR = "/etc/portsecure/repo-keys";
const REPOS_DIR = "/var/lib/portsecure/authorized-keys-repos";
const KEYS_HISTORY_PATH = "/var/lib/portsecure/authorized-keys-history";
const ROOT_AUTHORIZED_KEYS = "/root/.ssh/authorized_keys";
const SSHD_CONFIG_PATH = "/etc/ssh/sshd_config";
const SSHD_DROPIN_DIR = "/etc/ssh/sshd_config.d";
const SSHD_DROPIN_PATH = "/etc/ssh/sshd_config.d/00-portsecure.conf";
const PASSWD_PATH = "/etc/passwd";

const KEYS_CHECK_INTERVAL = 60 * 1000;
const REPO_POLL_INTERVAL = 5 * 60 * 1000;
const WEBHOOK_CHECK_INTERVAL = 5 * 60 * 1000;
// After this many consecutive failures the repo is thrown away and cloned from scratch, which
// recovers from corruption, half finished clones and interrupted fetches.
const MAX_REPO_FAILURES_BEFORE_RECLONE = 3;
const GIT_TIMEOUT = 120 * 1000;
const KEY_FILE_HEADER = "# Managed by portsecure. Manual changes are reverted and reported.";

const SSHD_DROPIN_CONTENTS = `# Managed by portsecure. Manual changes are reverted and reported.
# Keys come from the portsecure repo, so no other authentication method may be used.
PasswordAuthentication no
PermitEmptyPasswords no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
`;


// PORTED CODE: security/authorizedKeys/sources.ts is the TypeScript twin of these three, used by securessh.
// Both sides must derive identical paths from a repo url.
function sourceName(repoURL) {
    return repoURL.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function sourceKeyPath(repoURL) {
    return `${REPO_KEYS_DIR}/${sourceName(repoURL)}`;
}

function sourceRepoPath(repoURL) {
    return `${REPOS_DIR}/${sourceName(repoURL)}`;
}

/** Everything here is async on purpose: a daemon that blocks its event loop on disk or on a git
    fetch stops answering everything else while it waits. */
async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

/** Argument list rather than a shell string, so hostnames and paths can never be parsed as shell
    syntax. Resolves with the exit code instead of throwing, callers decide what a failure means. */
function spawnPromise(config) {
    let { command, args, cwd, input, timeoutTime } = config;
    return new Promise(resolve => {
        let child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let timer = undefined;
        let finish = result => {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            resolve(result);
        };
        if (timeoutTime) {
            timer = setTimeout(() => child.kill("SIGKILL"), timeoutTime);
        }
        child.stdout.on("data", chunk => stdout += chunk);
        child.stderr.on("data", chunk => stderr += chunk);
        child.on("error", e => finish({ stdout, stderr, status: undefined, error: e }));
        child.on("close", code => finish({ stdout, stderr, status: code, error: undefined }));
        child.stdin.on("error", () => undefined);
        child.stdin.end(input || "");
    });
}

// ---------------------------------------------------------------------------------------------
// Discord notifications
//
// PORTED CODE: this section is a hand port of security/notifications/discord.ts, kept plain JS so the
// daemon stays dependency free. The two are expected to behave identically - if you change one,
// make the matching change in the other.
// ---------------------------------------------------------------------------------------------

const DEFAULT_WEBHOOK_FILE_PATH = "/etc/portsecure/discord-webhook";
const VALID_WEBHOOK_PREFIXES = [
    "https://discord.com/api/webhooks/",
    "https://discordapp.com/api/webhooks/",
    "https://canary.discord.com/api/webhooks/",
];
const DISCORD_MESSAGE_LIMIT = 2000;
const MAX_ERROR_BODY_LENGTH = 500;
const MAX_SEND_ATTEMPTS = 3;
const DEFAULT_RATE_LIMIT_WAIT = 2 * 1000;
const REDACTED_TOKEN_VISIBLE = 8;

let notificationState = undefined;
let sendChain = Promise.resolve();

function parseWebhookFile(config) {
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

function redactWebhookURL(webhookURL) {
    let separatorIndex = webhookURL.lastIndexOf("/");
    let base = webhookURL.slice(0, separatorIndex + 1);
    let token = webhookURL.slice(separatorIndex + 1);
    if (token.length <= REDACTED_TOKEN_VISIBLE * 2) {
        return `${base}${token.slice(0, REDACTED_TOKEN_VISIBLE)}...`;
    }
    return `${base}${token.slice(0, REDACTED_TOKEN_VISIBLE)}...${token.slice(-REDACTED_TOKEN_VISIBLE)}`;
}

async function readWebhookFile(filePath) {
    if (!await pathExists(filePath)) {
        throw new Error(`Expected a Discord webhook file at ${filePath}, no such file exists`);
    }
    return parseWebhookFile({ contents: await fs.readFile(filePath, "utf8"), sourceName: filePath });
}

async function postToWebhook(webhookURL, message) {
    let content = message;
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

function queueSend(webhookURL, message) {
    let send = () => postToWebhook(webhookURL, message);
    let result = sendChain.then(send, send);
    sendChain = result.catch(() => undefined);
    return result;
}

async function configureDiscordNotifications(config) {
    let filePath = config && config.filePath || DEFAULT_WEBHOOK_FILE_PATH;
    let webhookURL;
    try {
        webhookURL = await readWebhookFile(filePath);
    } catch (e) {
        console.error(`portsecure: refusing to start without a valid Discord webhook file.\n${e}`);
        process.exit(1);
    }
    notificationState = { filePath, webhookURL };
    return { filePath };
}

async function sendDiscordNotification(message) {
    if (!notificationState) {
        throw new Error(`Expected configureDiscordNotifications to be called before sending, was called with message ${message.slice(0, MAX_ERROR_BODY_LENGTH)}`);
    }
    await queueSend(notificationState.webhookURL, message);
}

async function checkWebhookFileChanged() {
    if (!notificationState) {
        return;
    }
    let state = notificationState;
    let newWebhookURL;
    try {
        newWebhookURL = await readWebhookFile(state.filePath);
    } catch (e) {
        log(`Discord webhook file is no longer readable, still using the loaded webhook. ${e}`);
        return;
    }
    if (newWebhookURL === state.webhookURL) {
        return;
    }
    try {
        await queueSend(
            state.webhookURL,
            `${hostLabel()} the Discord webhook in \`${state.filePath}\` changed to`
            + ` \`${redactWebhookURL(newWebhookURL)}\`.`
            + ` Notifications are moving to the new webhook and this channel will stop receiving them.`
        );
    } catch (e) {
        log(`Failed to warn the old Discord webhook about the change. ${e}`);
    }
    state.webhookURL = newWebhookURL;
}

// ---------------------------------------------------------------------------------------------
// End of ported Discord code.
// ---------------------------------------------------------------------------------------------

let config = undefined;
let state = { sources: {}, userKeyHashes: {} };
let repoFailureCounts = {};

function log(message) {
    console.log(`${new Date().toISOString()} portsecure: ${message}`);
}

function hostLabel() {
    return `**portsecure [${config && config.hostLabel || os.hostname()}]**:`;
}

// DO NOT add new calls to this. Every message goes to a real Discord server someone reads, so a
// notification is only ever added when the user explicitly asks for that specific case. Startup,
// success, errors, retries and recoveries all belong in log() instead. The complete list of cases
// that are allowed to notify is at the top of this file.
async function notify(message) {
    try {
        await sendDiscordNotification(`${hostLabel()} ${message}`);
    } catch (e) {
        // A failed notification must never take the daemon down, the local log is the fallback.
        log(`Failed to send Discord notification. ${e}`);
    }
}

async function loadConfig() {
    if (!await pathExists(CONFIG_PATH)) {
        console.error(`portsecure: expected a config file at ${CONFIG_PATH}, no such file exists`);
        process.exit(1);
    }
    let parsed = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    if (!Array.isArray(parsed.repoSources)) {
        console.error(`portsecure: expected a repoSources array in ${CONFIG_PATH}, was ${JSON.stringify(parsed.repoSources)}`);
        process.exit(1);
    }
    for (let repoURL of parsed.repoSources) {
        if (!await pathExists(sourceKeyPath(repoURL))) {
            console.error(`portsecure: expected the private key for ${repoURL} at ${sourceKeyPath(repoURL)}, no such file exists`);
            process.exit(1);
        }
    }
    return {
        repoSources: parsed.repoSources,
        // The machine knows its own name, the config only overrides it when a nicer label helps.
        hostLabel: parsed.hostLabel || os.hostname(),
        webhookPath: DEFAULT_WEBHOOK_FILE_PATH,
    };
}

/** Per source progress, created on first use so a newly added source starts clean. */
function sourceState(repoURL) {
    let existing = state.sources[repoURL];
    if (existing) {
        return existing;
    }
    let created = { lastSha: "", branch: "" };
    state.sources[repoURL] = created;
    return created;
}

async function loadState() {
    if (!await pathExists(STATE_PATH)) {
        return;
    }
    try {
        let loaded = JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
        state = Object.assign(state, loaded);
    } catch (e) {
        // Corrupt state only costs us one duplicate notification, so it is not worth failing over.
        log(`Ignoring unreadable state file ${STATE_PATH}. ${e}`);
    }
}

async function saveState() {
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify(state, undefined, 4), { mode: 0o600 });
}

async function runGit(args, options) {
    let cwd = options && options.cwd;
    let keyPath = options && options.keyPath;
    // core.sshCommand keeps the key selection with the command instead of in the environment.
    let sshCommand = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
    let result = await spawnPromise({
        command: "git",
        args: ["-c", `core.sshCommand=${sshCommand}`, ...args],
        cwd,
        timeoutTime: GIT_TIMEOUT,
    });
    if (result.error) {
        throw new Error(`Expected git ${args.join(" ")} to run, failed with ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(
            `Expected git ${args.join(" ")} to exit 0, was ${result.status}. `
            + `${(result.stderr || "").slice(0, MAX_ERROR_BODY_LENGTH)}`
        );
    }
    return result.stdout.trim();
}

async function repoIsUsable(repoURL) {
    let repoPath = sourceRepoPath(repoURL);
    if (!await pathExists(path.join(repoPath, ".git"))) {
        return false;
    }
    try {
        await runGit(["rev-parse", "--git-dir"], { cwd: repoPath, keyPath: sourceKeyPath(repoURL) });
        return true;
    } catch (e) {
        log(`Repo at ${repoPath} is not usable. ${e}`);
        return false;
    }
}

async function cloneRepo(repoURL) {
    let repoPath = sourceRepoPath(repoURL);
    let keyPath = sourceKeyPath(repoURL);
    await fs.rm(repoPath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(repoPath), { recursive: true });
    await runGit(["clone", repoURL, repoPath], { keyPath });
    sourceState(repoURL).branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath, keyPath });
    log(`Cloned ${repoURL} into ${repoPath} on branch ${sourceState(repoURL).branch}`);
}

async function ensureRepo(repoURL) {
    if (await repoIsUsable(repoURL)) {
        if (!sourceState(repoURL).branch) {
            sourceState(repoURL).branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
                cwd: sourceRepoPath(repoURL),
                keyPath: sourceKeyPath(repoURL),
            });
        }
        return;
    }
    await cloneRepo(repoURL);
}

/** Returns what changed, so the caller can report it. A rewritten history is called out
    separately - it means the remote no longer contains the commits we already had. */
async function syncRepo(repoURL) {
    await ensureRepo(repoURL);
    let repoPath = sourceRepoPath(repoURL);
    let keyPath = sourceKeyPath(repoURL);
    let branch = sourceState(repoURL).branch;
    await runGit(["fetch", "--prune", "origin", branch], { cwd: repoPath, keyPath });
    let remoteSha = await runGit(["rev-parse", `origin/${branch}`], { cwd: repoPath, keyPath });
    let localSha = await runGit(["rev-parse", "HEAD"], { cwd: repoPath, keyPath });
    if (remoteSha === localSha && remoteSha === sourceState(repoURL).lastSha) {
        return { changed: false, historyRewritten: false, remoteSha, previousSha: localSha };
    }
    let previousSha = sourceState(repoURL).lastSha || localSha;
    let historyRewritten = false;
    if (previousSha && previousSha !== remoteSha) {
        // If what we already had is no longer an ancestor of the remote tip, commits were removed
        // or rewritten rather than added.
        let ancestry = await spawnPromise({
            command: "git",
            args: ["merge-base", "--is-ancestor", previousSha, remoteSha],
            cwd: repoPath,
            timeoutTime: GIT_TIMEOUT,
        });
        historyRewritten = ancestry.status !== 0;
    }
    await runGit(["reset", "--hard", `origin/${branch}`], { cwd: repoPath, keyPath });
    await runGit(["clean", "-fdx"], { cwd: repoPath, keyPath });
    return { changed: true, historyRewritten, remoteSha, previousSha };
}

function normalizeKeys(contents) {
    return contents.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
}

/** Enough to identify a key in a notification without printing the whole blob. */
function summarizeKey(keyLine) {
    let parts = keyLine.trim().split(/\s+/);
    let typeIndex = parts.findIndex(part => /^(ssh-|ecdsa-|sk-)/.test(part));
    if (typeIndex < 0) {
        return keyLine.slice(0, 60);
    }
    let type = parts[typeIndex];
    let blob = parts[typeIndex + 1] || "";
    let comment = parts.slice(typeIndex + 2).join(" ");
    return `${type} ...${blob.slice(-12)}${comment && ` ${comment}` || ""}`;
}

function describeKeyDifference(config) {
    let { before, after } = config;
    let added = after.filter(key => !before.includes(key));
    let removed = before.filter(key => !after.includes(key));
    let lines = [];
    for (let key of added) {
        lines.push(`+ ${summarizeKey(key)}`);
    }
    for (let key of removed) {
        lines.push(`- ${summarizeKey(key)}`);
    }
    if (!lines.length) {
        return "(no key lines differ)";
    }
    return lines.join("\n");
}

/** Reads one checkout's keys. Prefers a top level authorized_keys file and otherwise concatenates
    every .pub at the top level. */
async function readCheckoutKeys(repoPath) {
    let combinedPath = path.join(repoPath, "authorized_keys");
    if (await pathExists(combinedPath)) {
        return normalizeKeys(await fs.readFile(combinedPath, "utf8"));
    }
    let pubFiles = (await fs.readdir(repoPath)).filter(name => name.endsWith(".pub")).sort();
    if (!pubFiles.length) {
        throw new Error(`Expected authorized_keys or at least one .pub file in ${repoPath}, found neither`);
    }
    let keys = [];
    for (let name of pubFiles) {
        keys.push(...normalizeKeys(await fs.readFile(path.join(repoPath, name), "utf8")));
    }
    return keys;
}

/** The union of every source, in source order, with duplicates dropped. A source that cannot be
    read is skipped rather than emptying the merged set, so one broken repo cannot revoke the keys
    that came from the others. */
async function readRepoKeys() {
    let keys = [];
    let seen = new Set();
    for (let repoURL of config.repoSources) {
        let sourceKeys;
        try {
            sourceKeys = await readCheckoutKeys(sourceRepoPath(repoURL));
        } catch (e) {
            log(`Skipping ${repoURL}, its checkout could not be read. ${e}`);
            continue;
        }
        for (let key of sourceKeys) {
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            keys.push(key);
        }
    }
    return keys;
}

async function readAuthorizedKeysFile(filePath) {
    if (!await pathExists(filePath)) {
        return [];
    }
    return normalizeKeys(await fs.readFile(filePath, "utf8"));
}

async function writeAuthorizedKeysFile(config) {
    let { filePath, keys } = config;
    let directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    // Written to a temporary file first, so an interrupted write can never leave root with a
    // truncated authorized_keys and no way back in.
    let temporaryPath = `${filePath}.portsecure-tmp`;
    await fs.writeFile(temporaryPath, `${KEY_FILE_HEADER}\n${keys.join("\n")}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
}

/** Keeps a copy of whatever is about to be overwritten, named for the moment it was replaced.
    Recovers a key that was clobbered by mistake, and doubles as the history of who had access.
    The very first archive is the most valuable one, since it holds the keys from before portsecure
    took the file over. */
async function archiveAuthorizedKeys(config) {
    let { filePath, reason } = config;
    if (!await pathExists(filePath)) {
        return "";
    }
    let contents = await fs.readFile(filePath, "utf8");
    await fs.mkdir(KEYS_HISTORY_PATH, { recursive: true, mode: 0o700 });
    await fs.chmod(KEYS_HISTORY_PATH, 0o700);
    let stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let archivePath = path.join(KEYS_HISTORY_PATH, `${stamp}-${reason}.authorized_keys`);
    let attempt = 1;
    while (await pathExists(archivePath)) {
        attempt++;
        archivePath = path.join(KEYS_HISTORY_PATH, `${stamp}-${reason}-${attempt}.authorized_keys`);
    }
    await fs.writeFile(archivePath, contents, { mode: 0o600 });
    return archivePath;
}

/** Puts the repo's keys back in place if anything else changed them. */
async function enforceRootKeys(options) {
    let repoKeys = await readRepoKeys();
    if (!repoKeys.length) {
        // No sources, or none of them readable. Writing an empty file would lock everyone out, so
        // whatever access is already in place stays exactly as it is.
        log(`No keys came from any source, leaving ${ROOT_AUTHORIZED_KEYS} as it is`);
        return;
    }

    let currentKeys = await readAuthorizedKeysFile(ROOT_AUTHORIZED_KEYS);
    let matches = currentKeys.length === repoKeys.length && currentKeys.every((key, index) => key === repoKeys[index]);
    if (matches) {
        return;
    }
    let reason = options && options.reason || "manual";
    let archivePath = await archiveAuthorizedKeys({ filePath: ROOT_AUTHORIZED_KEYS, reason });
    await writeAuthorizedKeysFile({ filePath: ROOT_AUTHORIZED_KEYS, keys: repoKeys });
    let difference = describeKeyDifference({ before: currentKeys, after: repoKeys });
    let archiveNote = archivePath && `\nThe previous file is kept at \`${archivePath}\`.` || "";
    if (reason === "repo") {
        await notify(`root's authorized_keys was updated from the keys repo.\n\`\`\`\n${difference}\n\`\`\`${archiveNote}`);
        return;
    }
    await notify(
        `root's authorized_keys was changed outside portsecure and has been reverted to the keys repo.`
        + `\n\`\`\`\n${difference}\n\`\`\`${archiveNote}`
    );
}

async function listUserAuthorizedKeyFiles() {
    let entries = [];
    let passwd = await fs.readFile(PASSWD_PATH, "utf8");
    for (let line of passwd.split("\n")) {
        let fields = line.split(":");
        if (fields.length < 7) {
            continue;
        }
        let [name, , , , , home] = fields;
        if (!home || !await pathExists(home)) {
            continue;
        }
        entries.push({ name, filePath: path.join(home, ".ssh", "authorized_keys") });
    }
    return entries;
}

/** Root is enforced elsewhere, every other account is watched and reported on. */
async function checkOtherUserKeys() {
    let hashes = {};
    for (let entry of await listUserAuthorizedKeyFiles()) {
        if (entry.filePath === ROOT_AUTHORIZED_KEYS) {
            continue;
        }
        let keys = await readAuthorizedKeysFile(entry.filePath);
        let hash = crypto.createHash("sha256").update(keys.join("\n")).digest("hex");
        hashes[entry.name] = hash;
        let previousHash = state.userKeyHashes[entry.name];
        if (previousHash === undefined) {
            continue;
        }
        if (previousHash === hash) {
            continue;
        }
        await notify(
            `authorized_keys for user \`${entry.name}\` changed (\`${entry.filePath}\`).`
            + ` portsecure does not manage this account, so the change was left in place.`
            + `\n\`\`\`\n${keys.map(summarizeKey).join("\n") || "(now empty)"}\n\`\`\``
        );
    }
    state.userKeyHashes = hashes;
    await saveState();
}

async function sshdConfigIncludesDropinDir() {
    let contents = await fs.readFile(SSHD_CONFIG_PATH, "utf8");
    return contents.split("\n").some(line => {
        let trimmed = line.trim();
        return trimmed.startsWith("Include") && trimmed.includes("sshd_config.d");
    });
}

async function restartSSHD() {
    for (let unit of ["ssh", "sshd"]) {
        let result = await spawnPromise({ command: "systemctl", args: ["reload-or-restart", unit] });
        if (result.status === 0) {
            log(`Reloaded ${unit}`);
            return unit;
        }
    }
    throw new Error(`Expected to reload ssh or sshd, neither unit could be reloaded`);
}

/** Turns off every non key based way in. Validates before reloading, because a bad sshd config
    that gets applied is exactly how a machine becomes unreachable. */
async function enforceSSHDConfig() {
    let existing = "";
    if (await pathExists(SSHD_DROPIN_PATH)) {
        existing = await fs.readFile(SSHD_DROPIN_PATH, "utf8");
    }
    let includeMissing = !await sshdConfigIncludesDropinDir();
    if (existing === SSHD_DROPIN_CONTENTS && !includeMissing) {
        return;
    }

    let originalConfig = await fs.readFile(SSHD_CONFIG_PATH, "utf8");
    await fs.mkdir(SSHD_DROPIN_DIR, { recursive: true });
    await fs.writeFile(SSHD_DROPIN_PATH, SSHD_DROPIN_CONTENTS, { mode: 0o644 });
    if (includeMissing) {
        // sshd takes the first value it sees for most keywords, so the include has to come before
        // any setting it is meant to override.
        await fs.writeFile(SSHD_CONFIG_PATH, `Include ${SSHD_DROPIN_DIR}/*.conf\n${originalConfig}`);
    }

    let validation = await spawnPromise({ command: "sshd", args: ["-t"] });
    if (validation.error) {
        validation = await spawnPromise({ command: "/usr/sbin/sshd", args: ["-t"] });
    }
    if (validation.status !== 0) {
        // Roll back rather than leave a config that sshd would refuse on its next start.
        await fs.rm(SSHD_DROPIN_PATH, { force: true });
        if (includeMissing) {
            await fs.writeFile(SSHD_CONFIG_PATH, originalConfig);
        }
        log(
            `sshd rejected the portsecure config, rolled it back. `
            + `${(validation.stderr || "").slice(0, MAX_ERROR_BODY_LENGTH)}`
        );
        return;
    }

    let unit = await restartSSHD();
    log(`Password authentication disabled, reloaded ${unit}`);
}

/** Syncs one source. Returns whether the merged keys need reapplying. */
async function pollSource(repoURL) {
    let result;
    try {
        result = await syncRepo(repoURL);
        repoFailureCounts[repoURL] = 0;
    } catch (e) {
        let failures = (repoFailureCounts[repoURL] || 0) + 1;
        repoFailureCounts[repoURL] = failures;
        log(`Sync of ${repoURL} failed (${failures} in a row). ${e}`);
        if (failures < MAX_REPO_FAILURES_BEFORE_RECLONE) {
            return false;
        }
        // Availability over tidiness: throw the working copy away and start again.
        log(`Discarding the checkout of ${repoURL} and cloning from scratch`);
        try {
            await cloneRepo(repoURL);
            repoFailureCounts[repoURL] = 0;
            result = {
                changed: true,
                historyRewritten: false,
                remoteSha: await runGit(["rev-parse", "HEAD"], {
                    cwd: sourceRepoPath(repoURL),
                    keyPath: sourceKeyPath(repoURL),
                }),
                previousSha: sourceState(repoURL).lastSha,
            };
        } catch (cloneError) {
            log(`${repoURL} cannot be reached or cloned, its last known keys stay in place. ${cloneError}`);
            return false;
        }
    }

    if (result.historyRewritten) {
        await notify(
            `the history of \`${repoURL}\` was rewritten. Commit \`${result.previousSha.slice(0, 12)}\` is no`
            + ` longer an ancestor of \`${result.remoteSha.slice(0, 12)}\`, so history was force pushed or`
            + ` tampered with. The new state has been applied.`
        );
    }
    if (!result.changed) {
        return false;
    }
    sourceState(repoURL).lastSha = result.remoteSha;
    return true;
}

async function pollRepo() {
    let anyChanged = false;
    for (let repoURL of config.repoSources) {
        // One unreachable source must not stop the others from being checked.
        try {
            anyChanged = await pollSource(repoURL) || anyChanged;
        } catch (e) {
            log(`Polling ${repoURL} failed. ${e && e.stack || e}`);
        }
    }
    if (!anyChanged) {
        return;
    }
    await saveState();
    await enforceRootKeys({ reason: "repo" });
}

async function everyMinute() {
    await enforceRootKeys({ reason: "manual" });
    await checkOtherUserKeys();
    await enforceSSHDConfig();
}

function startInterval(config) {
    let { intervalTime, run, name } = config;
    let running = false;
    let tick = async () => {
        if (running) {
            log(`Skipping ${name}, the previous run has not finished`);
            return;
        }
        running = true;
        try {
            await run();
        } catch (e) {
            // Every scheduled job swallows its own errors, the daemon must outlive any single one.
            log(`${name} failed. ${e && e.stack || e}`);
        }
        running = false;
    };
    setInterval(tick, intervalTime);
    return tick;
}

async function main() {
    config = await loadConfig();
    await loadState();
    await configureDiscordNotifications({ filePath: config.webhookPath });

    log(`Starting, ${config.repoSources.length} source(s), keys applied to ${ROOT_AUTHORIZED_KEYS}`);

    // A first pass has to happen before the intervals, so a machine is correct immediately after
    // boot rather than a minute later.
    for (let repoURL of config.repoSources) {
        try {
            let result = await syncRepo(repoURL);
            sourceState(repoURL).lastSha = result.remoteSha;
        } catch (e) {
            log(`Initial sync of ${repoURL} failed, continuing with whatever is on disk. ${e}`);
        }
    }
    await saveState();

    // Seeds the per user hashes without reporting every existing file as a change.
    if (!Object.keys(state.userKeyHashes).length) {
        for (let entry of await listUserAuthorizedKeyFiles()) {
            if (entry.filePath === ROOT_AUTHORIZED_KEYS) {
                continue;
            }
            let keys = await readAuthorizedKeysFile(entry.filePath);
            state.userKeyHashes[entry.name] = crypto.createHash("sha256").update(keys.join("\n")).digest("hex");
        }
        await saveState();
    }

    await enforceRootKeys({ reason: "repo" });
    await enforceSSHDConfig();

    startInterval({ name: "key check", intervalTime: KEYS_CHECK_INTERVAL, run: everyMinute });
    startInterval({ name: "repo poll", intervalTime: REPO_POLL_INTERVAL, run: pollRepo });
    startInterval({ name: "webhook check", intervalTime: WEBHOOK_CHECK_INTERVAL, run: checkWebhookFileChanged });
}

process.on("uncaughtException", e => {
    log(`Uncaught exception, staying up. ${e && e.stack || e}`);
});
process.on("unhandledRejection", e => {
    log(`Unhandled rejection, staying up. ${e && e.stack || e}`);
});
process.on("SIGTERM", () => {
    log("Received SIGTERM, exiting");
    process.exit(0);
});

// Exported so the pieces can be exercised on their own. Running this file is what starts the
// daemon, requiring it does nothing.
module.exports = {
    normalizeKeys,
    summarizeKey,
    describeKeyDifference,
    redactWebhookURL,
    parseWebhookFile,
    readRepoKeys,
    readCheckoutKeys,
    sourceName,
    sourceKeyPath,
    sourceRepoPath,
    readAuthorizedKeysFile,
    writeAuthorizedKeysFile,
    archiveAuthorizedKeys,
    syncRepo,
    cloneRepo,
    ensureRepo,
    repoIsUsable,
    setConfig: value => { config = value; },
    getState: () => state,
};

if (require.main === module) {
    main().catch(e => {
        console.error(`portsecure: failed to start. ${e && e.stack || e}`);
        process.exit(1);
    });
}
