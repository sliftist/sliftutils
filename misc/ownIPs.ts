import os from "os";
import { getExternalIP } from "socket-function/src/networking";

/** Every address this machine can be reached at, or seen as.

    Both halves, because which one applies depends on who is doing the seeing: something on the
    same network sees one of our interface addresses, and anything past a NAT sees the address the
    NAT presents. A machine cannot work the second one out alone, which is why it is asked for.

    Loopback and the other internal interfaces are left out - nothing outside this machine ever
    sees us as those - and so is ipv6, because everything consuming this deals in ipv4.

    A set, because a machine that is not behind a NAT sees its own address in both halves. */
export async function getOwnIPs() {
    let addresses = new Set<string>();
    for (let entries of Object.values(os.networkInterfaces())) {
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
