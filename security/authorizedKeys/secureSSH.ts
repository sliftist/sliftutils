import fs from "fs/promises";
import os from "os";
import path from "path";
import { DEFAULT_WEBHOOK_FILE_PATH, parseWebhookFile } from "../notifications/discord";
import { normalizeKeys, readRepoKeys, summarizeKey } from "./authorizedKeys";
import { sourceKeyPath, sourceRepoPath } from "./sources";
import { expandHome } from "../helpers/paths";
import { spawnPromise } from "../helpers/spawn";
import { readRemoteFile, remoteCommandExists, runOverSSH, SUDO_PREAMBLE, writeRemoteFile } from "../helpers/remoteSSH";

const DAEMON_SOURCE = path.join(__dirname, "daemon", "portsecureDaemon.js");
const SERVICE_SOURCE = path.join(__dirname, "daemon", "portsecure.service");
const REMOTE_DAEMON_PATH = "/opt/portsecure/portsecure-daemon.js";
const REMOTE_SERVICE_PATH = "/etc/systemd/system/portsecure.service";
const REMOTE_CONFIG_PATH = "/etc/portsecure/daemon.json";
const ROOT_AUTHORIZED_KEYS = "/root/.ssh/authorized_keys";
const SERVICE_NAME = "portsecure";
const MAX_ERROR_BODY_LENGTH = 500;
const VERBS = ["add", "remove", "list"];
const USAGE = `Usage:
  yarn securessh <host> add <repo-private-key> <repo-url>
  yarn securessh <host> remove <repo-url>
  yarn securessh <host> list`;

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

async function runLocal(config: { command: string; args: string[]; allowFailure?: boolean }) {
    let { command, args, allowFailure } = config;
    let result = await spawnPromise({ command, args });
    if (result.error) {
        throw new Error(`Expected ${command} to run, failed with ${result.error.message}`);
    }
    if (result.status !== 0 && !allowFailure) {
        throw new Error(
            `Expected ${command} ${args.join(" ")} to exit 0, was ${result.status}. `
            + `${(result.stderr || "").slice(0, MAX_ERROR_BODY_LENGTH)}`
        );
    }
    return result;
}

/** A private key cannot authenticate an https remote, so github urls are converted to the ssh form
    the key can actually be used with. */
function normalizeRepoURL(repoURL: string) {
    let httpsMatch = repoURL.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
    if (!httpsMatch) {
        return repoURL;
    }
    let [, host, repoPath] = httpsMatch;
    return `git@${host}:${repoPath}.git`;
}

async function gitWithKey(config: { keyPath: string; args: string[]; cwd?: string; allowFailure?: boolean }) {
    let { keyPath, args, cwd, allowFailure } = config;
    // core.sshCommand keeps key selection with the command instead of in the environment.
    let sshCommand = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
    let result = await spawnPromise({ command: "git", args: ["-c", `core.sshCommand=${sshCommand}`, ...args], cwd });
    if (result.error) {
        throw new Error(`Expected git to run, failed with ${result.error.message}`);
    }
    if (result.status !== 0 && !allowFailure) {
        throw new Error(
            `Expected git ${args.join(" ")} to exit 0, was ${result.status}. `
            + `${(result.stderr || "").slice(0, MAX_ERROR_BODY_LENGTH)}`
        );
    }
    return result;
}

/** Asks ssh which key it actually authenticated with. This is the key that must survive the
    daemon taking over authorized_keys, otherwise a deploy locks us out. */
async function findAuthenticatingFingerprint(host: string) {
    let result = await spawnPromise({
        command: "ssh",
        args: ["-v", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "true"],
    });
    let verboseOutput = result.stderr || "";
    if (result.status !== 0) {
        throw new Error(`Expected to ssh into ${host}, failed. ${verboseOutput.slice(-MAX_ERROR_BODY_LENGTH)}`);
    }
    let acceptedMatch = verboseOutput.match(/Server accepts key:.*?(SHA256:[A-Za-z0-9+/=]+)/);
    if (!acceptedMatch) {
        throw new Error(
            `Expected ${host} to accept a public key, but the session did not authenticate with one.`
            + ` portsecure disables password login, so key based access has to work first.`
        );
    }
    return acceptedMatch[1];
}

async function fingerprintKeys(keys: string[]) {
    if (!keys.length) {
        return [];
    }
    let temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "portsecure-keys-"));
    let keysPath = path.join(temporaryDirectory, "authorized_keys");
    await fs.writeFile(keysPath, `${keys.join("\n")}\n`);
    let result = await runLocal({ command: "ssh-keygen", args: ["-lf", keysPath], allowFailure: true });
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    let fingerprints: string[] = [];
    for (let line of result.stdout.split("\n")) {
        let match = line.match(/(SHA256:[A-Za-z0-9+/=]+)/);
        if (match) {
            fingerprints.push(match[1]);
        }
    }
    return fingerprints;
}

async function cloneRepoForInspection(config: { repoURL: string; keyPath: string }) {
    let { repoURL, keyPath } = config;
    let temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "portsecure-repo-"));
    let repoPath = path.join(temporaryDirectory, "repo");
    await gitWithKey({ keyPath, args: ["clone", "--depth", "1", repoURL, repoPath] });
    return repoPath;
}

async function readRemoteConfig(host: string) {
    let contents = await readRemoteFile({ host, filePath: REMOTE_CONFIG_PATH });
    if (!contents) {
        return { hostLabel: host, repoSources: [] as string[] };
    }
    let parsed = JSON.parse(contents) as { hostLabel?: string; repoSources?: string[] };
    return { hostLabel: parsed.hostLabel || host, repoSources: parsed.repoSources || [] };
}

/** Reads the keys a source's checkout currently holds on the host, so the merged result can be
    worked out without needing that source's private key locally. */
async function readRemoteSourceKeys(config: { host: string; repoURL: string }) {
    let { host, repoURL } = config;
    let repoPath = sourceRepoPath(repoURL);
    let output = await runOverSSH({
        host,
        script: `${SUDO_PREAMBLE}
if $SUDO test -f "${repoPath}/authorized_keys"; then
    $SUDO cat "${repoPath}/authorized_keys"
elif $SUDO test -d "${repoPath}"; then
    $SUDO cat "${repoPath}"/*.pub 2>/dev/null || true
fi`,
        allowFailure: true,
    });
    return normalizeKeys(output.stdout);
}

async function installDaemon(config: { host: string; hostLabel: string; repoSources: string[] }) {
    let { host, hostLabel, repoSources } = config;
    for (let command of ["node", "git"]) {
        if (!await remoteCommandExists({ host, command })) {
            throw new Error(`Expected ${command} to be installed on ${host}, it is not. Install it and rerun.`);
        }
    }
    await writeRemoteFile({
        host,
        filePath: REMOTE_CONFIG_PATH,
        // Only what differs between machines. Every path the daemon uses is derived in the daemon
        // itself, so there is nothing here to drift out of sync.
        contents: JSON.stringify({ hostLabel, repoSources }, undefined, 4) + "\n",
        fileMode: "600",
        directoryMode: "700",
    });
    await writeRemoteFile({
        host,
        filePath: REMOTE_DAEMON_PATH,
        contents: await fs.readFile(DAEMON_SOURCE, "utf8"),
        fileMode: "755",
        directoryMode: "755",
    });
    await writeRemoteFile({
        host,
        filePath: REMOTE_SERVICE_PATH,
        contents: await fs.readFile(SERVICE_SOURCE, "utf8"),
        fileMode: "644",
        directoryMode: "755",
    });
    await runOverSSH({
        host,
        script: `${SUDO_PREAMBLE}
set -e
$SUDO systemctl daemon-reload
$SUDO systemctl enable ${SERVICE_NAME}
$SUDO systemctl restart ${SERVICE_NAME}`,
    });

    let status = (await runOverSSH({
        host,
        script: `systemctl is-active ${SERVICE_NAME} || true`,
        allowFailure: true,
    })).stdout.trim();
    if (status !== "active") {
        let journal = (await runOverSSH({
            host,
            script: `${SUDO_PREAMBLE}
$SUDO journalctl -u ${SERVICE_NAME} -n 40 --no-pager || true`,
            allowFailure: true,
        })).stdout;
        throw new Error(`Expected ${SERVICE_NAME} to be active on ${host}, was ${status}.\n${journal.slice(-2000)}`);
    }

    let stillReachable = await runOverSSH({ host, script: "echo reachable", allowFailure: true });
    if (stillReachable.stdout.trim() !== "reachable") {
        throw new Error(
            `Expected ${host} to still be reachable after the daemon started, it is not.`
            + ` Check console access immediately.`
        );
    }
}

async function requireRemoteWebhook(host: string) {
    let contents = await readRemoteFile({ host, filePath: DEFAULT_WEBHOOK_FILE_PATH });
    if (!contents) {
        throw new Error(
            `Expected a Discord webhook at ${DEFAULT_WEBHOOK_FILE_PATH} on ${host}, no such file exists.`
            + ` The daemon will not start without one.\n`
            + `Set it up first:\n  yarn setupnotify ${host} <discord-webhook-url>`
        );
    }
    return parseWebhookFile({ contents, sourceName: `${host}:${DEFAULT_WEBHOOK_FILE_PATH}` });
}

async function addSource(config: { host: string; keyPath: string; repoURL: string }) {
    let { host, keyPath, repoURL } = config;
    if (!await pathExists(keyPath)) {
        throw new Error(`Expected a private key at ${keyPath}, no such file exists`);
    }

    console.log(`Checking ${repoURL} is reachable with ${keyPath}`);
    let reachable = await gitWithKey({ keyPath, args: ["ls-remote", repoURL], allowFailure: true });
    if (reachable.status !== 0) {
        throw new Error(
            `Expected ${repoURL} to be reachable with ${keyPath}, git ls-remote failed.`
            + ` The daemon would have no way to fetch keys.\n${reachable.stderr.slice(0, MAX_ERROR_BODY_LENGTH)}`
        );
    }

    let remoteConfig = await readRemoteConfig(host);
    if (remoteConfig.repoSources.includes(repoURL)) {
        console.log(`${host} already has ${repoURL}, refreshing its key and the daemon.`);
    }

    // The merged result is what root ends up with, so our own key has to be somewhere in it.
    console.log(`Checking our access to ${host} survives the merged keys`);
    let ourFingerprint = await findAuthenticatingFingerprint(host);
    let inspectionPath = await cloneRepoForInspection({ repoURL, keyPath });
    let newKeys = await readRepoKeys(inspectionPath);
    // Whatever is applied on the host came from the existing sources, so it stays in the merge.
    let existingKeys = normalizeKeys(await readRemoteFile({ host, filePath: ROOT_AUTHORIZED_KEYS }) || "");
    let mergedFingerprints = await fingerprintKeys([...existingKeys, ...newKeys]);
    if (!mergedFingerprints.includes(ourFingerprint)) {
        throw new Error(
            `Expected the key we use for ${host} to be in the merged keys, it is not.\n`
            + `Ours:   ${ourFingerprint}\n`
            + `Merged: ${mergedFingerprints.join("\n        ") || "(none)"}\n`
            + `The daemon replaces root's authorized_keys with the merged sources, so this would`
            + ` lock you out of ${host}. Add your public key to ${repoURL} first.`
        );
    }
    console.log(`Our key ${ourFingerprint} is in the merged keys, access will survive.`);

    let webhookURL = await requireRemoteWebhook(host);
    console.log(`${host} notifies ${webhookURL}`);

    await writeRemoteFile({
        host,
        filePath: sourceKeyPath(repoURL),
        contents: await fs.readFile(keyPath, "utf8"),
        fileMode: "600",
        directoryMode: "700",
    });

    let repoSources = remoteConfig.repoSources.filter(source => source !== repoURL);
    repoSources.push(repoURL);
    await installDaemon({ host, hostLabel: remoteConfig.hostLabel, repoSources });
    console.log(`${repoURL} added to ${host}. ${repoSources.length} source(s) now merged.`);
}

async function removeSource(config: { host: string; repoURL: string }) {
    let { host, repoURL } = config;
    let remoteConfig = await readRemoteConfig(host);
    if (!remoteConfig.repoSources.includes(repoURL)) {
        throw new Error(
            `Expected ${repoURL} to be a source on ${host}, it is not.\n`
            + `Configured:\n  ${remoteConfig.repoSources.join("\n  ") || "(none)"}`
        );
    }
    let repoSources = remoteConfig.repoSources.filter(source => source !== repoURL);

    if (repoSources.length) {
        // The keys left over are what root gets, so our own key has to be among them.
        console.log(`Checking our access to ${host} survives without ${repoURL}`);
        let ourFingerprint = await findAuthenticatingFingerprint(host);
        let remainingKeys: string[] = [];
        for (let source of repoSources) {
            remainingKeys.push(...await readRemoteSourceKeys({ host, repoURL: source }));
        }
        let remainingFingerprints = await fingerprintKeys(remainingKeys);
        if (!remainingFingerprints.includes(ourFingerprint)) {
            throw new Error(
                `Expected the key we use for ${host} to still be in the remaining sources, it is not.\n`
                + `Ours:      ${ourFingerprint}\n`
                + `Remaining: ${remainingFingerprints.join("\n           ") || "(none)"}\n`
                + `Removing ${repoURL} would lock you out of ${host}.`
            );
        }
    } else {
        // Nothing left to merge, so the daemon leaves root's authorized_keys exactly as it is.
        console.log(`${repoURL} is the last source, so root's authorized_keys stays as it is now.`);
    }

    await requireRemoteWebhook(host);
    await runOverSSH({
        host,
        script: `${SUDO_PREAMBLE}
$SUDO rm -f "${sourceKeyPath(repoURL)}"
$SUDO rm -rf "${sourceRepoPath(repoURL)}"`,
    });
    await installDaemon({ host, hostLabel: remoteConfig.hostLabel, repoSources });
    console.log(`${repoURL} removed from ${host}. ${repoSources.length} source(s) left.`);
}

/** Answers "who can log into this box, and which repo says so". The paths the daemon uses are
    left out on purpose, they are plumbing rather than something to act on. */
async function listSources(host: string) {
    let remoteConfig = await readRemoteConfig(host);
    if (!remoteConfig.repoSources.length) {
        console.log(`${host} has no key sources. root's authorized_keys is left exactly as it is.`);
        return;
    }
    console.log(`${host} lets root log in with the keys from ${remoteConfig.repoSources.length} repo(s):`);
    let merged = new Set<string>();
    for (let repoURL of remoteConfig.repoSources) {
        let keys = await readRemoteSourceKeys({ host, repoURL });
        console.log(`\n  ${repoURL}`);
        if (!keys.length) {
            console.log(`    grants no keys - the checkout is missing or empty`);
            continue;
        }
        console.log(`    grants ${keys.length} key(s):`);
        for (let key of keys) {
            console.log(`      ${summarizeKey(key)}`);
            merged.add(key);
        }
    }
    if (remoteConfig.repoSources.length > 1) {
        console.log(`\n${merged.size} key(s) in total once duplicates are merged.`);
    }
}

/** The verb is a fixed word rather than a position, so it is pulled out of the arguments wherever
    it was typed and everything left over is positional. */
function parseArgs(argv: string[]) {
    let verbs = argv.filter(arg => VERBS.includes(arg));
    if (!verbs.length) {
        throw new Error(`Expected one of ${VERBS.join(", ")} somewhere in the arguments, was ${argv.join(" ") || "(nothing)"}\n${USAGE}`);
    }
    if (verbs.length > 1) {
        throw new Error(`Expected one of ${VERBS.join(", ")}, was ${verbs.join(" and ")}\n${USAGE}`);
    }
    let verb = verbs[0];
    let [host, ...rest] = argv.filter(arg => arg !== verb);
    if (!host) {
        throw new Error(`Expected a host, was nothing\n${USAGE}`);
    }
    return { verb, host, rest };
}

export async function main() {
    let { verb, host, rest } = parseArgs(process.argv.slice(2));

    if (verb === "list") {
        await listSources(host);
        return;
    }
    if (verb === "add") {
        if (rest.length !== 2) {
            throw new Error(`Expected a private key and a repo url, was ${rest.length} argument(s)\n${USAGE}`);
        }
        await addSource({ host, keyPath: expandHome(rest[0]), repoURL: normalizeRepoURL(rest[1]) });
        return;
    }
    if (rest.length !== 1) {
        throw new Error(`Expected a repo url to remove, was ${rest.length} argument(s)\n${USAGE}`);
    }
    await removeSource({ host, repoURL: normalizeRepoURL(rest[0]) });
}
