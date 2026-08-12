import os from "os";
import { getExternalIP } from "socket-function/src/networking";

// Interfaces belonging to containers and virtual machines, by the names the platforms give them:
// docker bridges and their veth pairs, libvirt and vmware and virtualbox switches, and the
// Hyper-V switches Windows creates for WSL and its VMs.
//
// Their addresses are skipped rather than trusted. An address on one of these is how something we
// deliberately sandboxed talks to us, so trusting a machine from it would hand the sandbox the
// access the sandbox exists to withhold - and no outside machine can reach us there anyway, so
// nothing is lost by leaving them out.
const VIRTUAL_INTERFACES = [
    /^docker/i,
    /^br-/i,
    /^veth/i,
    /^virbr/i,
    /^vmnet/i,
    /^vboxnet/i,
    /^vEthernet/i,
    /wsl/i,
    /hyper-?v/i,
];

function isVirtualInterface(name: string) {
    return VIRTUAL_INTERFACES.some(pattern => pattern.test(name));
}

/** Every address this machine can be reached at, or seen as.

    Both halves, because which one applies depends on who is doing the seeing: something on the
    same network sees one of our interface addresses, and anything past a NAT sees the address the
    NAT presents. A machine cannot work the second one out alone, which is why it is asked for.

    Loopback and the other internal interfaces are left out - nothing outside this machine ever
    sees us as those - and so is ipv6, because everything consuming this deals in ipv4.

    A set, because a machine that is not behind a NAT sees its own address in both halves. */
export async function getOwnIPs() {
    let addresses = new Set<string>();
    for (let [name, entries] of Object.entries(os.networkInterfaces())) {
        if (isVirtualInterface(name)) {
            console.log(`Ignoring ${name}, it belongs to a container or virtual machine`);
            continue;
        }
        for (let entry of entries || []) {
            if (!entry.internal && entry.family === "IPv4") {
                addresses.add(entry.address);
            }
        }
    }
    try {
        let external = (await getExternalIP()).trim();
        if (external) {
            addresses.add(external);
        }
    } catch (e) {
        // Offline, or every server that answers this is unreachable. The interface addresses are
        // still true, so they are still worth returning.
        console.warn(`Could not find out what our external address is. ${e}`);
    }
    return [...addresses];
}
