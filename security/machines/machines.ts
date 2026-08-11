import fs from "fs/promises";
import os from "os";
import path from "path";
import { CONFIG_PATH } from "../authorizedKeys/daemon/paths";
import { revokeRepo, syncRepoFiles } from "../authorizedKeys/daemon/repoFiles";
import { listRepoDir, readRepoFile } from "../authorizedKeys/daemon/repoFiles";
import { newRevocationId, pairKey, readRevocationFiles, readUnrevokes } from "../authorizedKeys/daemon/revocation";
import { runGit } from "../authorizedKeys/daemon/git";
import { ensureRevokeKey } from "../authorizedKeys/daemon/repoFiles";
import { verifyCheckout } from "../authorizedKeys/daemon/trust";
import { revokeRepoPath, revokeRepoURL } from "../authorizedKeys/revokeSource";
import { sourceRepoPath } from "../authorizedKeys/sources";
import { notify } from "../authorizedKeys/daemon/notify";
import { areDiscordNotificationsConfigured, configureDiscordNotifications, DEFAULT_WEBHOOK_FILE_PATH } from "../notifications/discord";
import { unrevokeInEffect } from "./trustState";
import { spawnPromise } from "../helpers/spawn";

// Which machines this system talks to, kept in the same repo as the ssh keys. That repo is already
// signed, already distributed to every machine, and already has somewhere to record a rejection,
// so a second one would only be a second thing to keep in step.
export const MACHINES_DIR = "machines";
const REVOCATIONS_DIR = "revocations";
const REVOCATION_REASON = "a machine talked to us from an unapproved IP";
// The revoke repo is pulled at most this often. A check happens per request, and a request must
// not cost a round trip to github.
const REVOKE_SYNC_INTERVAL = 60 * 1000;
// Where a Windows machine is expected to keep the repo, relative to the working directory. There
// is no daemon there to ask, and no /etc to look in.
const WINDOWS_REPO_PATH = "../authorized_keys";

/** One machine we are willing to talk to, and the addresses it may talk to us from. */
export type MachineState = {
    machineId: string;
    ips: string[];
    addedAt: string;
};

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

function machineFilePath(repoPath: string, machineId: string) {
    return path.join(repoPath, MACHINES_DIR, `${machineId}.json`);
}

/** Reads every machine a checkout lists, or sets them.

    Passing `machines` makes the repo match it exactly: machines named are written with the
    addresses given, and machines not named are removed. That is why the addresses are part of
    setting rather than a separate step - a machine with no address it may talk from is not a
    machine we would accept anyway, so there is no state where naming one without them means
    anything. Read first, change what you want, write the result.

    Nothing here signs or commits anything. The signature is what every other machine checks before
    believing any of this, and it takes the hardware key, so `yarn signfiles git` is still yours to
    run afterwards. */
export async function machineState(config: {
    repoPath: string;
    machines?: { machineId: string; ips: string[] }[];
}): Promise<MachineState[]> {
    let { repoPath, machines } = config;
    let existing = await readMachines(repoPath);
    if (!machines) {
        return [...existing.values()];
    }

    let directory = path.join(repoPath, MACHINES_DIR);
    let written: MachineState[] = [];
    for (let machine of machines) {
        if (!machine.machineId) {
            throw new Error(`Expected a machineId, was ${JSON.stringify(machine.machineId)}`);
        }
        if (!machine.ips.length) {
            throw new Error(
                `Expected addresses for ${machine.machineId}, was none. A machine is trusted from`
                + ` the addresses it may talk from, so leave it out of the list to remove it.`
            );
        }
        let ips = machine.ips.filter((ip, index) => ip && machine.ips.indexOf(ip) === index);
        let state: MachineState = {
            machineId: machine.machineId,
            // In the order given, without duplicates, so the file reads the way it was set.
            ips,
            addedAt: existing.get(machine.machineId)?.addedAt || new Date().toISOString(),
        };
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(machineFilePath(repoPath, state.machineId), JSON.stringify(state, undefined, 4) + "\n");
        written.push(state);
    }

    // Whatever the repo had and the caller did not name is no longer trusted.
    for (let machineId of existing.keys()) {
        if (!machines.some(machine => machine.machineId === machineId)) {
            await fs.rm(machineFilePath(repoPath, machineId), { force: true });
        }
    }
    return written;
}

/** Every machine the repo lists. */
async function readMachines(repoPath: string) {
    let machines = new Map<string, MachineState>();
    let directory = path.join(repoPath, MACHINES_DIR);
    let names = await fs.readdir(directory).catch(() => [] as string[]);
    for (let name of names.sort()) {
        if (!name.endsWith(".json")) {
            continue;
        }
        try {
            let parsed = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
            let machineId = parsed.machineId || name.replace(/\.json$/, "");
            machines.set(machineId, { machineId, ips: parsed.ips || [], addedAt: parsed.addedAt || "" });
        } catch (e) {
            console.log(`Ignoring unreadable machine file ${name}. ${e}`);
        }
    }
    return machines;
}

async function isKeysRepo(repoPath: string) {
    return await pathExists(path.join(repoPath, ".git"))
        && await pathExists(path.join(repoPath, "authorized_keys"));
}

async function originOf(repoPath: string) {
    let origin = await spawnPromise({ command: "git", args: ["remote", "get-url", "origin"], cwd: repoPath });
    let url = origin.stdout.trim();
    if (origin.status !== 0 || !url) {
        throw new Error(`Expected ${repoPath} to have an origin remote, it has none`);
    }
    return url;
}

/** The keys repo this machine answers from, and the one anything editing the machine list edits.

    On a host, that is the checkout the daemon already keeps up to date. On Windows there is no
    daemon and no /etc, so the repo is expected beside the working directory, which is where a
    developer working on both would have it.

    Never the directory the command happens to be run from. Which repo this machine trusts is a
    property of the machine, not of where somebody was standing when they typed something. */
export async function resolveKeysRepo() {
    if (os.platform() === "win32") {
        let repoPath = path.resolve(WINDOWS_REPO_PATH);
        if (!await isKeysRepo(repoPath)) {
            throw new Error(
                `Expected ${repoPath} to be an authorized_keys repo, it is not.\n`
                + `On Windows the repo is read from there, so clone it beside this one:\n`
                + `  git clone <your authorized_keys repo> ${repoPath}`
            );
        }
        return { repoPath, sourceURL: await originOf(repoPath) };
    }

    let config = await fs.readFile(CONFIG_PATH, "utf8").catch(() => "");
    let sourceURL = config && (JSON.parse(config).repoSources || [])[0] || "";
    if (!sourceURL) {
        throw new Error(
            `Expected this machine to be set up with an authorized_keys repo, ${CONFIG_PATH} names none.\n`
            + `Set it up first:\n`
            + `  yarn setupnotify <discord-webhook-url>\n`
            + `  yarn securessh add <repo-private-key> <repo-url>`
        );
    }
    let repoPath = sourceRepoPath(sourceURL);
    if (!await isKeysRepo(repoPath)) {
        throw new Error(
            `Expected a checkout of ${sourceURL} at ${repoPath}, there is none.\n`
            + `Run \`yarn securessh update\` to put it back.`
        );
    }
    return { repoPath, sourceURL };
}

let lastRevokeSync = 0;

/** Pulled at most once a REVOKE_SYNC_INTERVAL, because this is asked per request. A sync that
    fails leaves the checkout we already have, which is the safe direction: revocations we know
    about stay known. */
async function syncRevocations(sourceURL: string) {
    if (Date.now() - lastRevokeSync < REVOKE_SYNC_INTERVAL) {
        return;
    }
    lastRevokeSync = Date.now();
    try {
        await syncRepoFiles(revokeRepo(sourceURL));
    } catch (e) {
        console.log(`Could not read ${revokeRepoURL(sourceURL)}, using the revocations already here. ${e}`);
    }
}

/** Machine revocations, read out of the revoke repo the same way key revocations are. */
async function readMachineRevocations(sourceURL: string) {
    let repo = revokeRepo(sourceURL);
    let revocations: { revocationId: string; machineId: string; ip: string }[] = [];
    for (let name of await listRepoDir(repo, REVOCATIONS_DIR)) {
        if (!name.endsWith(".json")) {
            continue;
        }
        try {
            let parsed = JSON.parse(await readRepoFile(repo, path.join(REVOCATIONS_DIR, name)) || "");
            if (parsed.machineId) {
                revocations.push({
                    revocationId: parsed.revocationId || name.replace(/\.json$/, ""),
                    machineId: parsed.machineId,
                    ip: parsed.ip || "",
                });
            }
        } catch (e) {
            console.log(`Ignoring unreadable revocation ${name}. ${e}`);
        }
    }
    return revocations;
}

/** Sends the one notification this file is allowed to send, when it can.

    The daemon configures notifications on startup and would simply send. This can also run in some
    other process, which has not, so the webhook is picked up here if it is readable. A machine
    with no webhook set up still records the revocation - being unable to tell anyone is not a
    reason to keep accepting a machine that is being misused. */
async function notifyBestEffort(headline: string, body: string) {
    try {
        if (!areDiscordNotificationsConfigured()) {
            // Read first: configureDiscordNotifications exits the process when the file is missing,
            // which is right for the daemon at startup and wrong for a library call.
            await fs.readFile(DEFAULT_WEBHOOK_FILE_PATH, "utf8");
            await configureDiscordNotifications({ filePath: DEFAULT_WEBHOOK_FILE_PATH });
        }
        await notify(headline, body);
    } catch (e) {
        console.log(`Could not send a notification about this, it is only in the log. ${e}`);
    }
}

/** Records that a machine we accept talked to us from an address it is not allowed from. One per
    machine and address, so a second address is a second revocation and an unrevoke of the first
    does not cover it. */
async function recordMachineRevocation(config: {
    sourceURL: string;
    machineId: string;
    ip: string;
    hostLabel: string;
}) {
    let { sourceURL, machineId, ip, hostLabel } = config;
    let repoPath = revokeRepoPath(sourceURL);
    let keyPath = await ensureRevokeKey(sourceURL);
    let revocationId = newRevocationId(machineId);
    let directory = path.join(repoPath, REVOCATIONS_DIR);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${revocationId}.json`), JSON.stringify({
        revocationId,
        machineId,
        ip,
        revokedAt: new Date().toISOString(),
        revokedBy: hostLabel,
        reason: REVOCATION_REASON,
    }, undefined, 4) + "\n");

    await runGit({ args: ["add", "-A"], cwd: repoPath, keyPath });
    await runGit({
        args: ["-c", "user.email=portsecure@localhost", "-c", "user.name=portsecure", "commit", "-m", `revoke ${revocationId}`],
        cwd: repoPath, keyPath,
    });
    let push = await runGit({ args: ["push", "origin", "HEAD"], cwd: repoPath, keyPath, allowFailure: true });
    if (push.status !== 0) {
        // Another machine most likely recorded the same thing first, and the next read picks it up.
        console.log(`Could not push the revocation of ${machineId} from ${ip}. ${(push.stdout + push.stderr).trim()}`);
        return;
    }
    console.log(`Revoked ${machineId} from ${ip}, ${revocationId}`);

    // Said by whoever wrote the revocation, once, the same as for an ssh key. Machines that only
    // read it later say nothing, or one event would be reported by every machine that saw it.
    await notifyBestEffort(
        `SUSPICIOUS IP ${ip} FROZE MACHINE ${machineId}`,
        `A machine we trust talked to us from ${ip}, which is not an address it is allowed to talk`
        + ` from. It proved it holds that machine's key, so either someone else has a copy of it,`
        + ` or that machine's address changed.`
        + `\n\nIt is frozen everywhere now, and nothing accepts it.`
        + `\n\nIf this was an attack, remove \`machines/${machineId}.json\` from \`${sourceURL}\` now.`
        + `\nIf it was legitimate, run \`yarn unrevoke git\` in that repo. It allows ${ip} for that`
        + ` machine, and takes an hour to reach every machine.`
        + `\n\nmachine: \`${machineId}\``
        + `\nfrozen by: \`${hostLabel}\``
    );
}

/** Whether we will talk to this machine, coming from this address.

    Both halves are required and neither is a guess: the caller knows the machine id because the
    connection proved it, and knows the address because the packets came from there. A machine we
    do not list is simply not accepted. A machine we do list, arriving from an address it does not
    have, is treated as the same kind of event as a stolen ssh key - it is revoked everywhere, and
    stays revoked until an unrevoke allows that machine from that address.

    Throws when the repo itself cannot be read or is not signed, rather than answering false: that
    is a broken installation, not a rejected machine, and the two deserve different handling. */
export async function isMachineAccepted(config: { machineId: string; ip: string }): Promise<boolean> {
    let { machineId, ip } = config;
    if (!machineId || !ip) {
        throw new Error(`Expected a machineId and an ip, was ${JSON.stringify(machineId)} and ${JSON.stringify(ip)}`);
    }
    let { repoPath, sourceURL } = await resolveKeysRepo();
    // Unsigned, or signed over different contents, means the machine list is not evidence of
    // anything. Same gate the ssh keys go through.
    await verifyCheckout(repoPath);

    let machine = (await readMachines(repoPath)).get(machineId);
    if (!machine) {
        return false;
    }

    await syncRevocations(sourceURL);
    let unrevokes = await readUnrevokes(sourceURL).catch(() => ({ pairs: new Map(), legacyIds: new Map() }));
    // An unrevoke is only honoured once it has waited out its hour, exactly as an ssh key's is.
    let allowedAgain = async (pair: string) => {
        let unrevokeId = unrevokes.pairs.get(pair);
        return !!unrevokeId && await unrevokeInEffect(unrevokeId);
    };
    let revocations = await readMachineRevocations(sourceURL);
    // Any revocation nothing has undone keeps the machine out, from everywhere, the way a revoked
    // ssh key is out everywhere rather than only from the address it was misused from.
    let revoked = false;
    for (let revocation of revocations) {
        if (revocation.machineId !== machineId) {
            continue;
        }
        if (!await allowedAgain(pairKey({ fingerprint: revocation.machineId, ip: revocation.ip }))) {
            revoked = true;
        }
    }
    if (revoked) {
        return false;
    }

    if (machine.ips.includes(ip)) {
        return true;
    }

    // Listed, but talking to us from somewhere it should not be. Recorded once for this machine
    // and address, so being talked to repeatedly does not write repeatedly.
    let pair = pairKey({ fingerprint: machineId, ip });
    let alreadyRecorded = revocations.some(revocation =>
        pairKey({ fingerprint: revocation.machineId, ip: revocation.ip }) === pair);
    if (!alreadyRecorded && !await allowedAgain(pair)) {
        await recordMachineRevocation({ sourceURL, machineId, ip, hostLabel: os.hostname() });
    }
    return false;
}
