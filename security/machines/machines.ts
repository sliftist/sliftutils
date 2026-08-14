import fs from "fs/promises";
import os from "os";
import path from "path";
import { resolveKeysRepo } from "../authorizedKeys/keysRepo";
import { revokeRepo, syncRepoFiles } from "../authorizedKeys/daemon/repoFiles";
import { newRevocationId } from "../authorizedKeys/daemon/revocation";
import { runGit, syncRepo } from "../authorizedKeys/daemon/git";
import { ensureRevokeKey } from "../authorizedKeys/daemon/repoFiles";
import { isIdentityFrozen, isPairRevoked, isPairUnrevoked, noteRevocation, readSignedRepo } from "../authorizedKeys/daemon/readSignedRepo";
import { revokeRepoPath, revokeRepoURL } from "../authorizedKeys/revokeSource";
import { notify } from "../authorizedKeys/daemon/notify";
import { areDiscordNotificationsConfigured, configureDiscordNotifications, DEFAULT_WEBHOOK_FILE_PATH } from "../notifications/discord";
import { DEV_getIdentityFilePath, generateCA, getMachineId, getOwnMachineId, IdentityStorageType } from "../../misc/https/certs";
import { describeHost, runOverSSH, writeRemoteFile } from "../helpers/remoteSSH";
import { lazy } from "socket-function/src/caching";
import { runInfinitePoll } from "socket-function/src/batching";
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
// And the machine list is re-read from the checkout on this interval, in the background. The
// checkout itself only moves when the daemon pulls it, which is on the same sort of interval, so
// reading more often than this would only re-read the same bytes.
const MACHINES_REFRESH_INTERVAL = 60 * 1000;
// How long a failure to find the keys repo is remembered. A long lived process may start before
// the machine is set up, and should pick it up once it is, without being restarted - but it must
// not pay for resolving the repo on every request either.
const REPO_RETRY_DELAY = 15 * 1000;
const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
// The trusted machine list is re-read at most this often when a check rejects, so a caller that
// was just added is picked up quickly without letting a flood of rejections re-read every time.
const MACHINES_INVALIDATION_INTERVAL = 60 * 1000;
let lastMachinesInvalidation = 0;

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

/** This machine's keys repo, worked out once and then remembered.

    A failure is remembered too, but only briefly: a server may well start before the machine has
    been set up, and should start working when it is, rather than needing a restart. */
export const keysRepo = lazy(async () => {
    let lookup = resolveKeysRepo();
    lookup.catch(() => {
        setTimeout(() => keysRepo.reset(), REPO_RETRY_DELAY).unref();
    });
    return await lookup;
});

/** Every machine a checkout lists. Without a repo, this machine's own. */
export async function getMachines(repoPath?: string): Promise<MachineState[]> {
    return [...(await readMachines(repoPath || (await keysRepo()).repoPath)).values()];
}

/** The machines the signed files vouch for. Only the machine files covered by the signature are
    read - an unsigned machines/*.json is not evidence of anything, so readSignedRepo has already
    left it out. */
async function readTrustedMachines() {
    let { repoPath, sourceURL } = await keysRepo();
    let { files } = await readSignedRepo({ repoPath, sourceURL });
    let machines: MachineState[] = [];
    for (let [filePath, contents] of files) {
        let name = filePath.startsWith(`${MACHINES_DIR}/`) && filePath.slice(MACHINES_DIR.length + 1) || "";
        if (!name.endsWith(".json") || name.includes("/")) {
            continue;
        }
        let machine = parseMachineFile(name, contents.toString("utf8"));
        if (machine) {
            machines.push(machine);
        }
    }
    return machines;
}

const trustedMachines = lazy(async () => {
    let read = readTrustedMachines();
    read.catch(() => trustedMachines.reset());
    return await read;
});

let refreshing = false;

/** The machines this system trusts, as the signed repo lists them.

    Held rather than read per call, and refreshed in the background, so nobody asking whether a
    machine is trusted waits for a directory of files to be read and a signature to be checked. A
    refresh that fails leaves the list we already have: the checkout is only stale, not wrong. */
export async function getTrustedMachines(): Promise<MachineState[]> {
    if (!refreshing) {
        refreshing = true;
        runInfinitePoll(MACHINES_REFRESH_INTERVAL, async () => {
            try {
                trustedMachines.set(Promise.resolve(await readTrustedMachines()));
            } catch (e) {
                console.log(`Could not re-read the trusted machines, keeping the ones we have. ${e}`);
            }
        });
    }
    return await trustedMachines();
}

/** The machine id of a machine reached over ssh, generating and installing an identity for it if
    it has none under this domain. The private key ends up on that machine and nowhere else. */
export async function getOrCreateRemoteMachineId(host: string, domain: string): Promise<string> {
    let fileName = path.basename(DEV_getIdentityFilePath(domain));
    let home = (await runOverSSH({ host, script: `echo $HOME` })).stdout.trim();
    if (!home) {
        throw new Error(`Expected ${host} to report a home directory, it reported nothing`);
    }
    let contents = await runOverSSH({ host, script: `cat ${home}/${fileName} 2>/dev/null || true` });
    if (contents.stdout.trim()) {
        let stored = JSON.parse(contents.stdout) as IdentityStorageType;
        return getMachineId(stored.domain, domain);
    }
    console.log(`${describeHost(host)} has no identity for ${domain}, generating one`);
    let generated = generateCA(domain);
    let stored: IdentityStorageType = {
        domain: generated.domain,
        certB64: generated.cert.toString("base64"),
        keyB64: generated.key.toString("base64"),
    };
    await writeRemoteFile({
        host,
        filePath: `${home}/${fileName}`,
        contents: JSON.stringify(stored),
        fileMode: "600",
        directoryMode: "700",
    });
    return getMachineId(generated.domain, domain);
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
    repoPath?: string;
    machines: { machineId: string; ips: string[] }[];
}): Promise<MachineState[]> {
    let { machines } = config;
    let repoPath = config.repoPath || (await keysRepo()).repoPath;
    // Whatever was held is now stale, whoever reads it next.
    trustedMachines.reset();
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

function parseMachineFile(name: string, contents: string): MachineState | undefined {
    try {
        let parsed = JSON.parse(contents);
        let machineId = parsed.machineId || name.replace(/\.json$/, "");
        return { machineId, ips: parsed.ips || [], addedAt: parsed.addedAt || "" };
    } catch (e) {
        console.log(`Ignoring unreadable machine file ${name}. ${e}`);
        return undefined;
    }
}

/** Every machine file on disk. For editing the repo, not for deciding trust - trust reads the
    signed files through readTrustedMachines. */
async function readMachines(repoPath: string) {
    let machines = new Map<string, MachineState>();
    let directory = path.join(repoPath, MACHINES_DIR);
    let names = await fs.readdir(directory).catch(() => [] as string[]);
    for (let name of names.sort()) {
        if (!name.endsWith(".json")) {
            continue;
        }
        let machine = parseMachineFile(name, await fs.readFile(path.join(directory, name), "utf8").catch(() => ""));
        if (machine) {
            machines.set(machine.machineId, machine);
        }
    }
    return machines;
}

let lastRevokeSync = 0;

/** Pulls the keys repo and its revoke repo, at most once a REVOKE_SYNC_INTERVAL, because this is
    asked per request. Both, since either changing changes the answer: the keys repo carries the
    machines and unrevokes, the revoke repo carries the revocations. A sync that fails leaves the
    checkouts we already have. */
async function syncRevocations(sourceURL: string) {
    if (Date.now() - lastRevokeSync < REVOKE_SYNC_INTERVAL) {
        return;
    }
    lastRevokeSync = Date.now();
    await syncRepo(sourceURL).catch(e => console.log(`Could not sync ${sourceURL}, using the checkout already here. ${e}`));
    await syncRepoFiles(revokeRepo(sourceURL)).catch(e => console.log(`Could not sync ${revokeRepoURL(sourceURL)}, using the revocations already absorbed. ${e}`));
}

/** What to run to trust a machine that has just been refused.

    Everything in it is already known to whoever is being refused: their machine id, the address we
    saw them at, and the domain they just talked to. Handing it back saves them working out the
    parts of a command they have every right to know. Running it still takes the hardware key on
    the machine that owns the repo, so telling them costs nothing. */
export function addMachineCommand(config: { machineId: string; ip: string; domain?: string }) {
    let { machineId, ip, domain } = config;
    return `To trust ${machineId}, run: yarn addmachine ${domain || "<domain>"} ${machineId} ${ip} git`;
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
    noteRevocation(revocationId, machineId, ip);
    console.log(`Revoked ${machineId} from ${ip}, ${revocationId}`);

    // Said by whoever wrote the revocation, once, the same as for an ssh key. Machines that only
    // read it later say nothing, or one event would be reported by every machine that saw it.
    await notifyBestEffort(
        `SUSPICIOUS IP ${ip} FROZE MACHINE ${machineId}`,
        `Trusted machine ${machineId} talked to us from ${ip}, an address ${machineId} is not`
        + ` allowed from. The caller proved possession of ${machineId}'s key, so either someone`
        + ` else has a copy of the key, or the machine's address changed.`
        + `\n\nMachine ${machineId} is frozen everywhere now, and nothing accepts calls from ${machineId}.`
        + `\n\nIf this was an attack, remove \`machines/${machineId}.json\` from \`${sourceURL}\` now.`
        + `\nIf the new address is legitimate, run \`yarn unrevoke git\` in \`${sourceURL}\`. The`
        + ` unrevoke allows ${machineId} from ${ip}, and takes effect as each machine picks it up.`
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

export async function isMachineAccepted(config: {
    machineId: string;
    ip: string;
    // Used for local loopback acceptance, and for better error messages.
    domain?: string;
}): Promise<MachineVerdict> {
    let { machineId, ip, domain } = config;
    if (!machineId || !ip) {
        throw new Error(`Expected a machineId and an ip, was ${JSON.stringify(machineId)} and ${JSON.stringify(ip)}`);
    }

    // The whole check, plus whether it froze the machine. A rejection that froze it is final, so
    // there is nothing to gain from looking again. Any other rejection might just be a stale view -
    // a machine added seconds ago that our cached list has not caught up to - so it is worth one
    // fresh look, which is what the retry below does.
    let evaluate = async (): Promise<{ verdict: MachineVerdict; froze: boolean }> => {
        if (LOOPBACK.includes(ip) && !!domain && machineId === getOwnMachineId(domain)) {
            return { verdict: { accepted: true, reason: "" }, froze: false };
        }
        let { sourceURL } = await keysRepo();
        await syncRevocations(sourceURL);
        // The list has revocations already applied - readSignedRepo drops frozen machines - so a
        // machine in it is trusted, and a machine missing from it is either unknown or frozen.
        let machine = (await getTrustedMachines()).find(entry => entry.machineId === machineId);
        if (!machine) {
            if (isIdentityFrozen(machineId)) {
                return { verdict: { accepted: false, reason: `Machine ${machineId} is frozen, having been used from an unapproved address.` }, froze: false };
            }
            return { verdict: { accepted: false, reason: `Machine ${machineId} is not trusted. ${addMachineCommand({ machineId, ip, domain })}` }, froze: false };
        }

        if (machine.ips.includes(ip)) {
            return { verdict: { accepted: true, reason: "" }, froze: false };
        }

        // Listed, but talking to us from somewhere it should not be. Recorded once for this machine
        // and address, so being talked to repeatedly does not write repeatedly.
        if (!isPairRevoked(machineId, ip) && !isPairUnrevoked(machineId, ip)) {
            await recordMachineRevocation({ sourceURL, machineId, ip, hostLabel: os.hostname() });
            return { verdict: { accepted: false, reason: `Machine ${machineId} is not allowed from ${ip}, and is now frozen everywhere.` }, froze: true };
        }
        return { verdict: { accepted: false, reason: `Machine ${machineId} is not allowed from ${ip}.` }, froze: false };
    };

    let { verdict, froze } = await evaluate();
    // An accept, or a rejection that just froze the machine, is the final word. Any other rejection
    // might just be a stale list - a machine added seconds ago we have not caught up to - so it is
    // worth one fresh look.
    if (verdict.accepted || froze) {
        return verdict;
    }
    // Re-read the list at most once a minute, so a burst of bad callers cannot make us re-read on
    // every one of them. Force the checkout back to the remote first, so a machine added and signed
    // seconds ago is picked up even if the checkout was left dirty, then take the fresh look as
    // final.
    if (Date.now() - lastMachinesInvalidation > MACHINES_INVALIDATION_INTERVAL) {
        lastMachinesInvalidation = Date.now();
        let { sourceURL } = await keysRepo();
        await syncRepo(sourceURL, { forceUpdate: true }).catch(e => console.log(`Could not force update ${sourceURL}. ${e}`));
        trustedMachines.reset();
    }
    return (await evaluate()).verdict;
}
