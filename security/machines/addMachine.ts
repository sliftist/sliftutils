import { runPromise } from "socket-function/src/runPromise";
import { getOwnMachineId, loadIdentityCA } from "../../misc/https/certs";
import { getOwnIPs } from "../../misc/ownIPs";
import { resolveKeysRepo } from "../authorizedKeys/keysRepo";
import { signRepo } from "../signedFiles/signFiles";
import { getMachines, getOrCreateRemoteMachineId, setMachines } from "./machines";

const GIT_KEYWORD = "git";
const COMMIT_MESSAGE = "trusting a machine";
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

function parseArgs(argv: string[]) {
    let pushToGit = argv.includes(GIT_KEYWORD);
    let [domain, second, ...rest] = argv.filter(arg => arg !== GIT_KEYWORD);
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

/** Which machine to trust, and from which addresses. A named machine and its addresses as given, a
    machine reached over ssh at the address it was named by, or this machine at its own addresses. */
async function resolveMachine(config: { domain: string; host: string; machineId: string; addresses: string[] }) {
    let { domain, host, machineId, addresses } = config;
    if (machineId) {
        return { machineId, addresses };
    }
    if (host) {
        return { machineId: await getOrCreateRemoteMachineId(host, domain), addresses: [host] };
    }
    await loadIdentityCA(domain);
    let ownAddresses = await getOwnIPs();
    if (!ownAddresses.length) {
        throw new Error(`Expected this machine to have an address anything else can see, it has none`);
    }
    return { machineId: getOwnMachineId(domain), addresses: ownAddresses };
}

async function main() {
    let { domain, host, machineId, addresses, pushToGit } = parseArgs(process.argv.slice(2));
    let { repoPath } = await resolveKeysRepo();
    let target = await resolveMachine({ domain, host, machineId, addresses });

    let machines = await getMachines(repoPath);
    let existing = machines.find(machine => machine.machineId === target.machineId);
    let ips = [...(existing?.ips || [])];
    let added = target.addresses.filter(address => !ips.includes(address));
    if (existing) {
        existing.ips = [...ips, ...added];
    } else {
        machines.push({ machineId: target.machineId, ips: [...added], addedAt: "" });
    }
    await setMachines({ repoPath, machines });

    console.log(`\nTrusting machine ${target.machineId}`);
    console.log(`Allowing IP ${[...ips, ...added].join(", ")}`);
    if (added.length) {
        console.log(`  added to machines/${target.machineId}.json: ${added.join(", ")}`);
    } else {
        console.log(`  already allowed from ${target.addresses.join(", ")}`);
    }
    console.log(`  in ${repoPath}`);

    if (!pushToGit) {
        console.log(`\nNothing believes this until it is signed. In that repo, run:`);
        console.log(`\`\`\`\nyarn signfiles ${GIT_KEYWORD}\n\`\`\``);
        return;
    }
    await signRepo({ repoPath });
    await runPromise(`git add -A`, { cwd: repoPath });
    await runPromise(`git commit -m "${COMMIT_MESSAGE}"`, { cwd: repoPath });
    await runPromise(`git push`, { cwd: repoPath });
    console.log(`\nSigned, committed and pushed. Machines pick it up as they sync.`);
}

main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
