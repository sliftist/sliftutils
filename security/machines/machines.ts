import fs from "fs/promises";
import os from "os";
import path from "path";
import { resolveKeysRepo } from "../authorizedKeys/keysRepo";
import { revokeRepo, syncRepoFiles } from "../authorizedKeys/daemon/repoFiles";
import { listRepoDir, readRepoFile } from "../authorizedKeys/daemon/repoFiles";
import { newRevocationId, pairKey, readRevocationFiles, readUnrevokes } from "../authorizedKeys/daemon/revocation";
import { runGit } from "../authorizedKeys/daemon/git";
import { ensureRevokeKey } from "../authorizedKeys/daemon/repoFiles";
import { verifyCheckout } from "../authorizedKeys/daemon/trust";
import { revokeRepoPath, revokeRepoURL } from "../authorizedKeys/revokeSource";
import { notify } from "../authorizedKeys/daemon/notify";
import { areDiscordNotificationsConfigured, configureDiscordNotifications, DEFAULT_WEBHOOK_FILE_PATH } from "../notifications/discord";
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

/** Every machine a checkout lists. */
export async function getMachines(repoPath: string): Promise<MachineState[]> {
    return [...(await readMachines(repoPath)).values()];
}

/** Makes a checkout list exactly these machines: those named are written with the addresses given,
    and anything not named is removed. So read them, change what you want, and write the result.

    The addresses are part of setting rather than a separate step, because a machine with no
    address it may talk from is not a machine that would ever be accepted - there is no state where
    naming one without them means anything.

    Nothing here signs or commits. The signature is what every other machine checks before
    believing any of this, and it takes the hardware key, so `yarn signfiles git` is still yours to
    run afterwards. */
export async function setMachines(config: {
    repoPath: string;
    machines: { machineId: string; ips: string[] }[];
}): Promise<MachineState[]> {
    let { repoPath, machines } = config;
    let existing = await readMachines(repoPath);
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
        + ` machine, and takes effect as each machine picks it up.`
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

    Says why when the answer is no, because the three ways to be refused are entirely different
    things to a person reading it: never trusted at all, trusted but frozen, or trusted and talking
    from somewhere it should not be.

    Throws when the repo itself cannot be read or is not signed, rather than answering false: that
    is a broken installation, not a rejected machine, and the two deserve different handling. */
export type MachineVerdict = { accepted: boolean; reason: string };

export async function isMachineAccepted(config: { machineId: string; ip: string }): Promise<MachineVerdict> {
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
        return { accepted: false, reason: "that machine is not trusted" };
    }

    await syncRevocations(sourceURL);
    let unrevokes = await readUnrevokes(sourceURL).catch(() => ({ pairs: new Map(), legacyIds: new Map() }));
    // An unrevoke counts as soon as it is seen. It is signed, so writing one already takes the
    // hardware key, and anyone holding that can sign anything at all - a wait before honouring it
    // guards against an attacker who has no need of it.
    let allowedAgain = (pair: string) => !!unrevokes.pairs.get(pair)?.length;
    let revocations = await readMachineRevocations(sourceURL);
    // Any revocation nothing has undone keeps the machine out, from everywhere, the way a revoked
    // ssh key is out everywhere rather than only from the address it was misused from.
    let frozenFrom = "";
    for (let revocation of revocations) {
        if (revocation.machineId !== machineId) {
            continue;
        }
        if (!allowedAgain(pairKey({ fingerprint: revocation.machineId, ip: revocation.ip }))) {
            frozenFrom = revocation.ip;
        }
    }
    if (frozenFrom) {
        return {
            accepted: false,
            reason: `that machine is frozen, it was used from ${frozenFrom} which it is not allowed from`,
        };
    }

    if (machine.ips.includes(ip)) {
        return { accepted: true, reason: "" };
    }

    // Listed, but talking to us from somewhere it should not be. Recorded once for this machine
    // and address, so being talked to repeatedly does not write repeatedly.
    let pair = pairKey({ fingerprint: machineId, ip });
    let alreadyRecorded = revocations.some(revocation =>
        pairKey({ fingerprint: revocation.machineId, ip: revocation.ip }) === pair);
    if (!alreadyRecorded && !allowedAgain(pair)) {
        await recordMachineRevocation({ sourceURL, machineId, ip, hostLabel: os.hostname() });
        return { accepted: false, reason: `that machine is not allowed from ${ip}, so it is now frozen everywhere` };
    }
    return { accepted: false, reason: `that machine is not allowed from ${ip}` };
}
