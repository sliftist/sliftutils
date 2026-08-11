import os from "os";
import { describeHost } from "../helpers/remoteSSH";
import { createRemoteIdentity, localDomains, localIdentity, remoteIdentity } from "./identity";
import { machineState, resolveKeysRepo } from "./machines";

const USAGE = `Usage: yarn addmachine <domain> [ip]

The domain is required: a machine has a different identity, and so a different machine id, under
every domain it runs under, so there is no such thing as "this machine" without one.

With no ip it adds this machine, with its own addresses. With an ip it asks that machine over ssh
for its identity under that domain, gives it one if it has none, and adds it under that address.

It edits the keys repo this machine reads, wherever that is, not whatever directory this was run
from. Nothing is signed or pushed here. Run "yarn signfiles git" in that repo afterwards, or no
machine will believe any of it.`;

/** This machine's own addresses, which are what it would be talking to anything else from. */
function localAddresses() {
    let addresses: string[] = [];
    for (let entries of Object.values(os.networkInterfaces())) {
        for (let entry of entries || []) {
            if (!entry.internal && entry.family === "IPv4") {
                addresses.push(entry.address);
            }
        }
    }
    return addresses;
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

    let identity;
    let addresses: string[];
    if (!host) {
        identity = await localIdentity(domain);
        if (!identity) {
            throw new Error(
                `Expected an identity for ${domain} in ${os.homedir()}, this machine has none.\n`
                + `It has: ${(await localDomains()).join(", ") || "no identities at all"}\n`
                + `One is generated the first time something runs here under a domain, so run that`
                + ` first, or name another machine to add instead.`
            );
        }
        addresses = localAddresses();
        if (!addresses.length) {
            throw new Error(`Expected this machine to have a non local address, it has none`);
        }
    } else {
        identity = await remoteIdentity(host, domain);
        if (!identity) {
            // Nothing there under this domain, so it gets one. Its own from this point on: the key
            // is written there and nothing keeps a copy.
            console.log(`${describeHost(host)} has no identity for ${domain}, generating one`);
            identity = await createRemoteIdentity({ host, domain });
        }
        // The address it was named by is the address it talks to us from, which is the one thing
        // it cannot lie about.
        addresses = [host];
    }

    let existing = await machineState({ repoPath, machineId: identity.machineId });
    let ips = [...(existing?.ips || [])];
    let added = addresses.filter(address => !ips.includes(address));
    await machineState({ repoPath, machineId: identity.machineId, ips: [...ips, ...added] });

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
