import { signTrustPacket } from "./identity";

// The other half of the demonstration: asks a server whether it trusts this machine. The answer
// depends on the address this machine reaches the server from, which is why the client cannot
// work it out alone.
const TRUST_PATH = "/trusted";
const USAGE = `Usage: yarn machineclient <url> <domain>

Asks that server whether this machine is trusted, proving which machine it is with a signed packet.
The server decides using the address we reach it from, so the answer is about how we are talking to
it, not only about who we are.

The domain is required: this machine has a different identity under each one, and the answer is
about the identity we sign with.`;

export type TrustAnswer = {
    trusted: boolean;
    machineId?: string;
    ip?: string;
    reason?: string;
};

/** Asks one server whether it trusts this machine, as it is under this domain. */
export async function askIfTrusted(config: { baseURL: string; domain: string }): Promise<TrustAnswer> {
    let { baseURL, domain } = config;
    let packet = await signTrustPacket(domain);
    let url = `${baseURL.replace(/\/+$/, "")}${TRUST_PATH}`;
    let response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(packet),
    });
    return await response.json() as TrustAnswer;
}

export async function main() {
    let [baseURL, domain] = process.argv.slice(2);
    if (!baseURL || !domain) {
        throw new Error(USAGE);
    }
    let answer = await askIfTrusted({ baseURL, domain });
    console.log(`${answer.trusted && "TRUSTED" || "NOT TRUSTED"} by ${baseURL}`);
    console.log(`  machine ${answer.machineId || "(not established)"}`);
    console.log(`  seen coming from ${answer.ip || "(unknown)"}`);
    if (answer.reason) {
        console.log(`  ${answer.reason}`);
    }
    if (!answer.trusted) {
        process.exitCode = 1;
    }
}
