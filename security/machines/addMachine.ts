import path from "path";
import { runPromise } from "socket-function/src/runPromise";
import { DEV_getIdentityFilePath, generateCA, getMachineId, getOwnMachineId, IdentityStorageType, loadIdentityCA } from "../../misc/https/certs";
import { getOwnIPs } from "../../misc/ownIPs";
import { describeHost, runOverSSH, writeRemoteFile } from "../helpers/remoteSSH";
import { resolveKeysRepo } from "../authorizedKeys/keysRepo";
import { signRepo } from "../signedFiles/signFiles";
import { getMachines, setMachines } from "./machines";

const GIT_KEYWORD = "git";
const COMMIT_MESSAGE = "trusting a machine";
// A machine id is the base32 hash of a public key, written with a leading b. Nothing else that can
// appear in these arguments looks like that, which is what tells it apart from an ssh target.
const MACHINE_ID = /^b[a-z2-7]{20}$/;
const USAGE = `Usage:
  yarn addmachine <domain> [${GIT_KEYWORD}]
  yarn addmachine <domain> <ssh-host> [${GIT_KEYWORD}]
  yarn addmachine <domain> <machine-id> <ip> [ip...] [${GIT_KEYWORD}]

The domain is required: a machine has a different identity, and so a different machine id, under
every domain it runs under, so there is no such thing as "this machine" without one.

With nothing else it adds this machine, with its own addresses. With an ssh host it asks that
machine for its identity under that domain, gives it one if it has none, and adds it under that
address. With a machine id it adds exactly that machine at exactly those addresses, without
talking to anything.

It edits the keys repo this machine reads, wherever that is, not whatever directory this was run
from. With ${GIT_KEYWORD} it signs, commits and pushes; without it nothing else will believe any of
this until you do.`;

/** A domain, then either nothing, an ssh host, or a machine id and the addresses it may talk from. */
function parseArgs(argv: string[]) {
    let pushToGit = argv.includes(GIT_KEYWORD);
    let positional = argv.filter(arg => arg !== GIT_KEYWORD);
    let [domain, second, ...rest] = positional;
    if (!domain) {
        throw new Error(`Expected a domain\n${USAGE}`);
    }
    if (!second) {
        return { domain, host: "", machineId: "", addresses: [] as string[], pushToGit };
    }
    if (MACHINE_ID.test(second)) {
        if (!rest.length) {
            throw new Error(`Expected at least one address for ${second}, was none\n${USAGE}`);
        }
        return { domain, host: "", machineId: second, addresses: rest, pushToGit };
    }
    if (rest.length) {
        throw new Error(
            `Expected nothing after the ssh host ${second}, was ${rest.join(" ")}.\n`
            + `Addresses are only given alongside a machine id.\n${USAGE}`
        );
    }
    return { domain, host: second, machineId: "", addresses: [] as string[], pushToGit };
}

/** The machine id of a machine reached over ssh, generating and installing an identity for it if
    it has none under this domain. The private key ends up on that machine and nowhere else. */
async function getOrCreateRemoteMachineId(host: string, domain: string): Promise<string> {
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

export async function main() {
    let { domain, host, machineId, addresses, pushToGit } = parseArgs(process.argv.slice(2));
    // The same repo the acceptance check reads. Editing anything else would write a machine list
    // nothing on this machine ever looks at.
    let { repoPath } = await resolveKeysRepo();

    if (!machineId && !host) {
        await loadIdentityCA(domain);
        machineId = getOwnMachineId(domain);
        addresses = await getOwnIPs();
        if (!addresses.length) {
            throw new Error(`Expected this machine to have an address anything else can see, it has none`);
        }
    } else if (host) {
        machineId = await getOrCreateRemoteMachineId(host, domain);
        addresses = [host];
    }

    // The whole list is read and written back, because setting is by the set: writing this one
    // machine alone would remove every other machine from the repo.
    let machines = await getMachines(repoPath);
    let existing = machines.find(machine => machine.machineId === machineId);
    let ips = [...(existing?.ips || [])];
    let added = addresses.filter(address => !ips.includes(address));
    if (existing) {
        existing.ips = [...ips, ...added];
    } else {
        machines.push({ machineId, ips: [...added], addedAt: "" });
    }
    await setMachines({ repoPath, machines });

    console.log(`\nTrusting machine ${machineId}`);
    console.log(`Allowing IP ${[...ips, ...added].join(", ")}`);
    if (added.length) {
        console.log(`  added to machines/${machineId}.json: ${added.join(", ")}`);
    } else {
        console.log(`  already allowed from ${addresses.join(", ")}`);
    }
    console.log(`  in ${repoPath}`);

    if (!pushToGit) {
        console.log(`\nNothing believes this until it is signed. In that repo, run:`);
        console.log(`\`\`\`\nyarn signfiles ${GIT_KEYWORD}\n\`\`\``);
        return;
    }
    // Signed here rather than left as a step to remember, the same as unrevoke does it. A machine
    // list nobody signed is ignored by every machine that reads it.
    await signRepo({ repoPath });
    await runPromise(`git add -A`, { cwd: repoPath });
    await runPromise(`git commit -m "${COMMIT_MESSAGE}"`, { cwd: repoPath });
    await runPromise(`git push`, { cwd: repoPath });
    console.log(`\nSigned, committed and pushed. Machines pick it up as they sync.`);
}
