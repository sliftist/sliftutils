import fs from "fs/promises";
import os from "os";
import path from "path";
import { DEFAULT_WEBHOOK_FILE_PATH, parseWebhookFile } from "../notifications/discord";
import { normalizeKeys, readRepoKeys, summarizeKey } from "./authorizedKeys";
import { sourceKeyPath, sourceRepoPath } from "./sources";
import { deriveRevokeKey, REVOKE_KEY_LABEL, revokeRepoURL } from "./revokeSource";
import { revokedKeysInRepo } from "./unrevoke";
import { expandHome } from "../helpers/paths";
import { spawnPromise } from "../helpers/spawn";
import { describeHost, readRemoteFile, remoteCommandExists, runOverSSH, SUDO_PREAMBLE, THIS_MACHINE, writeRemoteFile } from "../helpers/remoteSSH";

const SERVICE_SOURCE = path.join(__dirname, "daemon", "portsecure.service");
// The daemon runs from a checkout of this repo on the host, rather than from a copy we upload, so
// a host updates itself from github the same way anything else does. sliftutils is public, so this
// needs no key.
const SLIFTUTILS_URL = "https://github.com/sliftist/sliftutils.git";
const REMOTE_CHECKOUT_PATH = "/opt/portsecure/sliftutils";
const REMOTE_SERVICE_PATH = "/etc/systemd/system/portsecure.service";
const REMOTE_CONFIG_PATH = "/etc/portsecure/daemon.json";
const ROOT_AUTHORIZED_KEYS = "/root/.ssh/authorized_keys";
const SERVICE_NAME = "portsecure";
const MAX_ERROR_BODY_LENGTH = 500;
const VERBS = ["add", "remove", "list", "update"];
// The host is optional, and without one everything happens on this machine. The repo url is
// optional too, and defaults to the repo the command is run from.
const USAGE = `Usage:
  yarn securessh [host] add <repo-private-key> [repo-url]
  yarn securessh [host] remove [repo-url]
  yarn securessh [host] list
  yarn securessh [host] update

With no host it acts on this machine, and still installs from github rather than from wherever
this was run.`;

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

async function runLocal(config: { command: string; args: string[]; cwd?: string; allowFailure?: boolean }) {
    let { command, args, cwd, allowFailure } = config;
    let result = await spawnPromise({ command, args, cwd });
    if (result.error) {
        throw new Error(`Expected ${command} to run, failed with ${result.error.message}`);
    }
    if (result.status !== 0 && !allowFailure) {
        throw new Error(
            `Expected ${command} ${args.join(" ")} to exit 0, was ${result.status}. `
            + `${(result.stdout + result.stderr).trim().slice(0, MAX_ERROR_BODY_LENGTH)}`
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
            + `${(result.stdout + result.stderr).trim().slice(0, MAX_ERROR_BODY_LENGTH)}`
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

/** With no repo url given, the repo we are standing in is used. It has to actually hold keys
    before we hand it to a host, so a stray working directory cannot be deployed by accident. */
async function resolveRepoURL(passedURL: string | undefined) {
    if (passedURL) {
        return normalizeRepoURL(passedURL);
    }
    let topLevel = await runLocal({ command: "git", args: ["rev-parse", "--show-toplevel"], allowFailure: true });
    if (topLevel.status !== 0) {
        throw new Error(`Expected a repo url, or the current directory to be inside a git repo, it is not.\n${USAGE}`);
    }
    let repoPath = topLevel.stdout.trim();
    try {
        await readRepoKeys(repoPath);
    } catch (e) {
        throw new Error(
            `Expected a repo url, or the current repo (${repoPath}) to hold keys, it does not.\n${e}\n${USAGE}`
        );
    }
    let origin = await runLocal({
        command: "git",
        args: ["remote", "get-url", "origin"],
        cwd: repoPath,
        allowFailure: true,
    });
    if (origin.status !== 0 || !origin.stdout.trim()) {
        throw new Error(
            `Expected the current repo (${repoPath}) to have an origin remote, it has none.`
            + ` The host clones the source itself, so a local path is no use to it.`
        );
    }
    let repoURL = normalizeRepoURL(origin.stdout.trim());
    console.log(`No repo url given, using the current repo: ${repoURL}`);
    return repoURL;
}

/** Every source's revoke repo has to exist and hold at least one commit, or the hosts using it
    cannot record a revocation. Checked with this machine's own git credentials, since update is
    not given any deploy key, and an empty repo is initialised rather than merely complained about.

    A host that cannot write a revocation silently keeps accepting a key it just saw being misused,
    which is the one failure this whole thing exists to prevent, so it is checked on every deploy
    and not only when a source is first added. */
async function ensureRevokeReposExist(repoSources: string[]) {
    for (let repoURL of repoSources) {
        let revokeURL = revokeRepoURL(repoURL);
        let temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "portsecure-revoke-"));
        let checkoutPath = path.join(temporaryDirectory, "repo");
        // On a machine that is already a portsecure host, the source's deploy key is right there,
        // and the key derived from it is the one credential that repo is guaranteed to accept.
        // Anywhere else, a person is running this and has their own access.
        let ownKey = "";
        if (await pathExists(sourceKeyPath(repoURL))) {
            let derived = deriveRevokeKey(await fs.readFile(sourceKeyPath(repoURL), "utf8"));
            ownKey = path.join(temporaryDirectory, "key");
            await fs.writeFile(ownKey, derived.privateKeyFile, { mode: 0o600 });
        }
        let cloneRevoke = async (allowFailure: boolean) => ownKey
            && await gitWithKey({ keyPath: ownKey, args: ["clone", revokeURL, checkoutPath], allowFailure })
            || await runLocal({ command: "git", args: ["clone", revokeURL, checkoutPath], allowFailure });
        let clone = await cloneRevoke(true);
        if (clone.status !== 0) {
            await fs.rm(temporaryDirectory, { recursive: true, force: true });
            throw new Error(
                `Expected ${revokeURL} to exist, it does not, so ${repoURL} has nowhere to record a`
                + ` revocation.\nCreate it, then run "yarn securessh <host> add" for that source to`
                + ` register its deploy key.\n${(clone.stdout + clone.stderr).trim().slice(0, MAX_ERROR_BODY_LENGTH)}`
            );
        }
        let head = await runLocal({ command: "git", args: ["-C", checkoutPath, "rev-parse", "HEAD"], allowFailure: true });
        if (head.status !== 0) {
            console.log(`${revokeURL} is empty, giving it a first commit`);
            await fs.writeFile(path.join(checkoutPath, "README.md"),
                `# revoked keys\n\nWritten by portsecure. Each file under revocations/ is one key that was used from an\n`
                + `address it is not allowed from, and is no longer accepted anywhere.\n`);
            for (let args of [
                ["-C", checkoutPath, "add", "-A"],
                ["-C", checkoutPath, "-c", "user.email=portsecure@localhost", "-c", "user.name=portsecure", "commit", "-m", "initialise revoke repo"],
            ]) {
                await runLocal({ command: "git", args });
            }
            let push = ["-C", checkoutPath, "push", "origin", "HEAD"];
            if (ownKey) {
                await gitWithKey({ keyPath: ownKey, args: push });
            } else {
                await runLocal({ command: "git", args: push });
            }
        }
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
        console.log(`${revokeURL} is ready`);
    }
}

/** The revoke repo has to exist and be writable before a host is set up, because a host that
    cannot write a revocation cannot revoke a key that is being misused. The key for it is derived
    from the source's, since github will not take one public key on two repos. */
async function ensureRevokeRepo(config: { keyPath: string; repoURL: string }) {
    let { keyPath, repoURL } = config;
    let revokeURL = revokeRepoURL(repoURL);
    let derived = deriveRevokeKey(await fs.readFile(keyPath, "utf8"));

    let temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "portsecure-revoke-"));
    let derivedKeyPath = path.join(temporaryDirectory, "key");
    await fs.writeFile(derivedKeyPath, derived.privateKeyFile, { mode: 0o600 });
    let checkoutPath = path.join(temporaryDirectory, "repo");

    let explain = (problem: string) => new Error(
        `${problem}\n`
        + `Create ${revokeURL} and add this as a deploy key WITH WRITE ACCESS:\n`
        + `  ${derived.publicKey} ${REVOKE_KEY_LABEL}\n`
        + `It has to be this key: it is derived from ${keyPath}, and github will not accept the same`
        + ` public key on two repositories.`
    );

    console.log(`Checking ${revokeURL}`);
    let clone = await gitWithKey({ keyPath: derivedKeyPath, args: ["clone", revokeURL, checkoutPath], allowFailure: true });
    if (clone.status !== 0) {
        throw explain(`Expected ${revokeURL} to be readable with the derived key, it is not.`);
    }

    // An empty repo has no branch for the daemon to clone, so it gets its first commit here. That
    // doubles as the proof that we can write to it.
    let head = await gitWithKey({ keyPath: derivedKeyPath, args: ["rev-parse", "HEAD"], cwd: checkoutPath, allowFailure: true });
    if (head.status !== 0) {
        await fs.writeFile(path.join(checkoutPath, "README.md"),
            `# revoked keys\n\nWritten by portsecure. Each file under revocations/ is one key that was used from an\n`
            + `address it is not allowed from, and is no longer accepted anywhere.\n`);
        for (let args of [
            ["add", "-A"],
            ["-c", "user.email=portsecure@localhost", "-c", "user.name=portsecure", "commit", "-m", "initialise revoke repo"],
        ]) {
            await gitWithKey({ keyPath: derivedKeyPath, args, cwd: checkoutPath });
        }
        let push = await gitWithKey({ keyPath: derivedKeyPath, args: ["push", "origin", "HEAD"], cwd: checkoutPath, allowFailure: true });
        if (push.status !== 0) {
            throw explain(`Expected write access to ${revokeURL}, the first push was refused.\n${(push.stdout + push.stderr).trim().slice(0, MAX_ERROR_BODY_LENGTH)}`);
        }
    } else {
        let dryRun = await gitWithKey({ keyPath: derivedKeyPath, args: ["push", "--dry-run", "origin", "HEAD"], cwd: checkoutPath, allowFailure: true });
        if (dryRun.status !== 0) {
            throw explain(`Expected write access to ${revokeURL}, a dry run push was refused.\n${(dryRun.stdout + dryRun.stderr).trim().slice(0, MAX_ERROR_BODY_LENGTH)}`);
        }
    }

    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    console.log(`${revokeURL} is writable`);
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
    for (let command of ["node", "git", "yarn"]) {
        if (!await remoteCommandExists({ host, command })) {
            throw new Error(`Expected ${command} to be installed on ${host}, it is not. Install it and rerun.`);
        }
    }

    // The checkout is brought to the latest commit rather than a copy being pushed, so what runs on
    // the host is exactly what is on github.
    console.log(`Updating ${REMOTE_CHECKOUT_PATH} on ${describeHost(host)}`);
    await runOverSSH({
        host,
        script: `${SUDO_PREAMBLE}
set -e
$SUDO mkdir -p "${path.posix.dirname(REMOTE_CHECKOUT_PATH)}"
if $SUDO test -d "${REMOTE_CHECKOUT_PATH}/.git"; then
    # Stashed first, the way machine-alwaysup does it. Anything sitting modified in a host's
    # checkout is either an accident or somebody editing the daemon in place, and either way it is
    # worth keeping rather than quietly erasing. The identity is passed inline because a host has
    # no git config of its own and stash writes a commit.
    $SUDO git -C "${REMOTE_CHECKOUT_PATH}" add --all
    $SUDO git -C "${REMOTE_CHECKOUT_PATH}" -c user.email=portsecure@localhost -c user.name=portsecure stash
    $SUDO git -C "${REMOTE_CHECKOUT_PATH}" fetch --prune origin
    # A stash and a pull cannot cross a branch that has diverged, and a drifted checkout must not be
    # able to leave a host running old code, so it is put on the remote's state rather than merged
    # with it. set-head so that is the remote's default branch now, not the one it had at clone.
    $SUDO git -C "${REMOTE_CHECKOUT_PATH}" remote set-head origin --auto
    $SUDO git -C "${REMOTE_CHECKOUT_PATH}" reset --hard origin/HEAD
else
    $SUDO rm -rf "${REMOTE_CHECKOUT_PATH}"
    $SUDO git clone "${SLIFTUTILS_URL}" "${REMOTE_CHECKOUT_PATH}"
fi
$SUDO yarn --cwd "${REMOTE_CHECKOUT_PATH}" install --production --non-interactive
# The single file daemon this replaced, left over on a host set up by an older version.
$SUDO rm -f /opt/portsecure/portsecure-daemon.js`,
    });
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
            + `Set it up first:\n  yarn setupnotify ${host} <discord-webhook-url>`.replace(" <discord", host && " <discord" || "<discord")
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
            + ` The daemon would have no way to fetch keys.\n`
            + `${(reachable.stdout + reachable.stderr).trim().slice(0, MAX_ERROR_BODY_LENGTH)}`
        );
    }

    let remoteConfig = await readRemoteConfig(host);
    if (remoteConfig.repoSources.includes(repoURL)) {
        console.log(`${describeHost(host)} already has ${repoURL}, refreshing its key and the daemon.`);
    }

    // The merged result is what root ends up with, so our own key has to be somewhere in it. On
    // this machine there is no ssh session to preserve, so there is nothing to check.
    let ourFingerprint = "";
    if (host) {
        console.log(`Checking our access to ${describeHost(host)} survives the merged keys`);
        ourFingerprint = await findAuthenticatingFingerprint(host);
    }
    let inspectionPath = await cloneRepoForInspection({ repoURL, keyPath });
    let newKeys = await readRepoKeys(inspectionPath);
    // Whatever is applied on the host came from the existing sources, so it stays in the merge.
    let existingKeys = normalizeKeys(await readRemoteFile({ host, filePath: ROOT_AUTHORIZED_KEYS }) || "");
    let mergedFingerprints = await fingerprintKeys([...existingKeys, ...newKeys]);
    if (ourFingerprint && !mergedFingerprints.includes(ourFingerprint)) {
        throw new Error(
            `Expected the key we use for ${host} to be in the merged keys, it is not.\n`
            + `Ours:   ${ourFingerprint}\n`
            + `Merged: ${mergedFingerprints.join("\n        ") || "(none)"}\n`
            + `The daemon replaces root's authorized_keys with the merged sources, so this would`
            + ` lock you out of ${host}. Add your public key to ${repoURL} first.`
        );
    }
    if (ourFingerprint) {
        console.log(`Our key ${ourFingerprint} is in the merged keys, access will survive.`);
    }

    await ensureRevokeRepo({ keyPath, repoURL });

    // Deploying a repo that still holds a revoked key would hand it back to every machine.
    let revoked = await revokedKeysInRepo({ repoPath: inspectionPath, sourceURL: repoURL });
    if (revoked.length) {
        throw new Error(
            `Expected ${repoURL} to hold no revoked keys, it holds ${revoked.length}:\n`
            + revoked.map(entry => `  ${entry.revocation.fingerprint} revoked by`
                + ` ${entry.revocation.revokedBy || "?"} after use from ${entry.revocation.attempt?.ip || "?"}`).join("\n")
            + `\nDelete them from the repo, or run "yarn unrevoke" there to allow them again.`
        );
    }

    let webhookURL = await requireRemoteWebhook(host);
    console.log(`${describeHost(host)} notifies ${webhookURL}`);

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
    console.log(`${repoURL} added to ${describeHost(host)}. ${repoSources.length} source(s) now merged.`);
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

    // On this machine there is no ssh session to preserve, so there is nothing to check.
    if (repoSources.length && host) {
        // The keys left over are what root gets, so our own key has to be among them.
        console.log(`Checking our access to ${describeHost(host)} survives without ${repoURL}`);
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
    console.log(`${repoURL} removed from ${describeHost(host)}. ${repoSources.length} source(s) left.`);
}

/** Answers "who can log into this box, and which repo says so". The paths the daemon uses are
    left out on purpose, they are plumbing rather than something to act on. */

/** Pushes the current daemon onto a host that already has one, for when this code has moved on.
    Nothing about which keys the host trusts is touched. */
async function updateDaemon(host: string) {
    let contents = await readRemoteFile({ host, filePath: REMOTE_CONFIG_PATH });
    if (!contents) {
        throw new Error(
            `Expected ${host} to already have portsecure, ${REMOTE_CONFIG_PATH} does not exist.\n`
            + `Set it up with:\n  yarn securessh ${host} add <repo-private-key> [repo-url]`
        );
    }
    let parsed = JSON.parse(contents) as { hostLabel?: string; repoSources?: string[] };
    let repoSources = parsed.repoSources || [];
    await requireRemoteWebhook(host);
    await ensureRevokeReposExist(repoSources);
    await installDaemon({ host, hostLabel: parsed.hostLabel || host, repoSources });
    console.log(`Updated the daemon on ${describeHost(host)}, and restarted it.`);
    console.log(`Its ${repoSources.length} key source(s) were left as they are, along with the keys and`);
    console.log(`signers it has already accepted. Only the daemon itself changed:`);
    for (let repoURL of repoSources) {
        console.log(`  ${repoURL}`);
    }
}

async function listSources(host: string) {
    let remoteConfig = await readRemoteConfig(host);
    if (!remoteConfig.repoSources.length) {
        console.log(`${describeHost(host)} has no key sources. root's authorized_keys is left exactly as it is.`);
        return;
    }
    console.log(`${describeHost(host)} lets root log in with the keys from ${remoteConfig.repoSources.length} repo(s):`);
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
    let positional = argv.filter(arg => arg !== verb);
    // A host, when there is one, comes first and is a bare name or address. Everything else that
    // can appear here is a path or a repo url, and those all carry a slash, which is what tells
    // them apart. So no host at all means this machine.
    let host = THIS_MACHINE;
    if (positional.length && !/[\/~\\]/.test(positional[0])) {
        host = positional[0];
        positional = positional.slice(1);
    }
    return { verb, host, rest: positional };
}

export async function main() {
    let { verb, host, rest } = parseArgs(process.argv.slice(2));

    if (verb === "list") {
        await listSources(host);
        return;
    }
    if (verb === "update") {
        if (rest.length) {
            throw new Error(`Expected nothing after update, was ${rest.length} argument(s)\n${USAGE}`);
        }
        await updateDaemon(host);
        return;
    }
    if (verb === "add") {
        if (!rest.length || rest.length > 2) {
            throw new Error(`Expected a private key and optionally a repo url, was ${rest.length} argument(s)\n${USAGE}`);
        }
        await addSource({ host, keyPath: expandHome(rest[0]), repoURL: await resolveRepoURL(rest[1]) });
        return;
    }
    if (rest.length > 1) {
        throw new Error(`Expected at most a repo url to remove, was ${rest.length} argument(s)\n${USAGE}`);
    }
    await removeSource({ host, repoURL: await resolveRepoURL(rest[0]) });
}
