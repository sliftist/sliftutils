import os from "os";
import { describeHost } from "../helpers/remoteSSH";
import { createRemoteIdentity, Identity, localDomains, localIdentity, remoteIdentity } from "./identity";
import { machineState, resolveKeysRepo } from "./machines";

const USAGE = `Usage: yarn addmachine <domain> [ip]

The domain is required: a machine has a different identity, and so a different machine id, under
every domain it runs under, so there is no such thing as "this machine" without one.

With no ip it adds this machine, with its own addresses. With an ip it asks that machine over ssh
for its identity under that domain, gives it one if it has none, and adds it under that address.

It edits the keys repo this machine reads, wherever that is, not whatever directory this was run
from. Nothing is signed or pushed here. Run "yarn signfiles git" in that repo afterwards, or no
machine will believe any of it.`;

// Asked what address the world sees us as. A machine cannot work that out alone: on this side of
// a NAT it only knows its own interfaces, and anything across the NAT sees the router.
const EXTERNAL_IP_URL = "https://api.ipify.org";
const EXTERNAL_IP_TIMEOUT = 10 * 1000;

/** The address the internet sees us as, or "" if we could not find out. */
async function externalAddress() {
    try {
        let response = await fetch(EXTERNAL_IP_URL, { signal: AbortSignal.timeout(EXTERNAL_IP_TIMEOUT) });
        let address = (await response.text()).trim();
        return /^[0-9.]+$/.test(address) && address || "";
    } catch (e) {
        console.log(`Could not ask ${EXTERNAL_IP_URL} what our external address is. ${e}`);
        return "";
    }
}

/** Every address this machine could be talking to something else from: the real ones on its own
    interfaces, and the one the world sees it as. Loopback and link local are left out, since
    nothing reaches us on those, and ipv6 is left out because the entries are ipv4.

    Both, because which one applies depends on who is being talked to: something on the same
    network sees an interface address, and anything past the NAT sees the external one. They are
    often the same address on a machine that is not behind a NAT, hence the set. */
async function localAddresses() {
    let addresses = new Set<string>();
    for (let entries of Object.values(os.networkInterfaces())) {
        for (let entry of entries || []) {
            if (!entry.internal && entry.family === "IPv4") {
                addresses.add(entry.address);
            }
        }
    }
    let external = await externalAddress();
    if (external) {
        addresses.add(external);
    }
    return [...addresses];
}

export async function main() {
    let argv = process.argv.slice(2);
    if (!argv.length || argv.length > 2) {
        throw new Error(`Expected a domain and optionally an ip, was ${argv.length} argument(s)\n${USAGE}`);
    }
    let [domain, host = ""] = argv;
    // The same repo the acceptance check reads. Editing anything else would write a machine list
    // nothing on this machine ever looks at.
    let { repoPath } = await resolveKeysRepo();

    let identity: Identity;
    let addresses: string[];
    if (!host) {
        let found = await localIdentity(domain);
        if (!found) {
            throw new Error(
                `Expected an identity for ${domain} in ${os.homedir()}, this machine has none.\n`
                + `It has: ${(await localDomains()).join(", ") || "no identities at all"}\n`
                + `One is generated the first time something runs here under a domain, so run that`
                + ` first, or name another machine to add instead.`
            );
        }
        identity = found;
        addresses = await localAddresses();
        if (!addresses.length) {
            throw new Error(`Expected this machine to have a non local address, it has none`);
        }
    } else {
        // Nothing there under this domain means it gets one. Its own from this point on: the key
        // is written there and nothing keeps a copy.
        let found = await remoteIdentity(host, domain);
        if (!found) {
            console.log(`${describeHost(host)} has no identity for ${domain}, generating one`);
        }
        identity = found || await createRemoteIdentity({ host, domain });
        // The address it was named by is the address it talks to us from, which is the one thing
        // it cannot lie about.
        addresses = [host];
    }

    // The whole list is read and written back, because setting is by the set: writing this one
    // machine alone would remove every other machine from the repo.
    let machines = await machineState({ repoPath });
    let existing = machines.find(machine => machine.machineId === identity.machineId);
    let ips = [...(existing?.ips || [])];
    let added = addresses.filter(address => !ips.includes(address));
    if (existing) {
        existing.ips = [...ips, ...added];
    } else {
        machines.push({ machineId: identity.machineId, ips: [...added], addedAt: "" });
    }
    await machineState({ repoPath, machines });

    console.log(`\nTrusting machine ${identity.machineId}`);
    console.log(`Allowing IP ${[...ips, ...added].join(", ")}`);
    if (added.length) {
        console.log(`  added to machines/${identity.machineId}.json: ${added.join(", ")}`);
    } else {
        console.log(`  already allowed from ${addresses.join(", ")}`);
    }
    console.log(`  identity ${identity.fullDomain}`);
    console.log(`  in ${repoPath}`);
    console.log(`\nNothing believes this until it is signed. In that repo, run:`);
    console.log(`\`\`\`\nyarn signfiles git\n\`\`\``);
}
