import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { generateTestCA, getMachineId, identityStorageKey, IdentityStorageType, verifyMachineIdForPublicKey } from "../../misc/https/certs";
import { runOverSSH, writeRemoteFile } from "../helpers/remoteSSH";

// A machine's identity is the CA it generated for itself, kept in one file in the home directory
// of whoever runs it. The name carries the domain it belongs to, so a machine can hold one per
// domain, and the id itself is a hash of that CA's public key - which is why a machine cannot
// claim to be another one without holding its key.
const IDENTITY_PREFIX = "keystore_";
const IDENTITY_SUFFIX = `_${identityStorageKey}.json`;
// How stale a signed packet may be. Long enough for clock skew between two machines, short enough
// that a captured packet is not worth replaying.
export const PACKET_LIFETIME = 2 * 60 * 1000;

export type Identity = {
    machineId: string;
    domain: string;
    fullDomain: string;
    fileName: string;
};

function identityFileName(domain: string) {
    return `${IDENTITY_PREFIX}${domain}${IDENTITY_SUFFIX}`;
}

/** The domain out of an identity file's name, or "" if it is not one. */
function domainOfFileName(fileName: string) {
    if (!fileName.startsWith(IDENTITY_PREFIX) || !fileName.endsWith(IDENTITY_SUFFIX)) {
        return "";
    }
    return fileName.slice(IDENTITY_PREFIX.length, -IDENTITY_SUFFIX.length);
}

function describeIdentity(config: { domain: string; stored: IdentityStorageType }) {
    let { domain, stored } = config;
    return {
        machineId: getMachineId(stored.domain, domain),
        domain,
        fullDomain: stored.domain,
        fileName: identityFileName(domain),
    };
}

/** Every domain this machine holds an identity under. A machine has one identity per domain, and
    they are different machine ids, so which one is meant is a real question rather than a detail. */
export async function localDomains() {
    let domains: string[] = [];
    for (let name of (await fs.readdir(os.homedir()).catch(() => [] as string[])).sort()) {
        let domain = domainOfFileName(name);
        if (domain) {
            domains.push(domain);
        }
    }
    return domains;
}

/** This machine's identity under one domain. Undefined when it has none under that one.

    The domain is required everywhere it appears. A machine has a different identity, and so a
    different machine id, under every domain it runs under, so "this machine" on its own does not
    name anything: answering under the wrong one means answering as a machine we are not. */
export async function localIdentity(domain: string): Promise<Identity | undefined> {
    if (!domain) {
        throw new Error(`Expected a domain, was ${JSON.stringify(domain)}`);
    }
    let contents = await fs.readFile(path.join(os.homedir(), identityFileName(domain)), "utf8").catch(() => "");
    if (!contents) {
        return undefined;
    }
    return describeIdentity({ domain, stored: JSON.parse(contents) });
}

/** This machine's identity and its keys, for signing. */
export async function localIdentityKeys(domain: string) {
    let identity = await localIdentity(domain);
    if (!identity) {
        throw new Error(
            `Expected an identity for ${domain} at ${path.join(os.homedir(), identityFileName(domain))},`
            + ` there is none.\n`
            + `This machine has: ${(await localDomains()).join(", ") || "no identities at all"}`
        );
    }
    let stored: IdentityStorageType = JSON.parse(
        await fs.readFile(path.join(os.homedir(), identity.fileName), "utf8")
    );
    return { identity, stored };
}

/** The identity of another machine under one domain, over ssh. Undefined when it has none under
    that domain, whatever else it may have under others. */
export async function remoteIdentity(host: string, domain: string): Promise<Identity | undefined> {
    if (!domain) {
        throw new Error(`Expected a domain, was ${JSON.stringify(domain)}`);
    }
    let home = (await runOverSSH({ host, script: `echo $HOME` })).stdout.trim();
    if (!home) {
        throw new Error(`Expected ${host} to report a home directory, it reported nothing`);
    }
    let contents = await runOverSSH({
        host,
        script: `cat ${home}/${identityFileName(domain)} 2>/dev/null || true`,
    });
    if (!contents.stdout.trim()) {
        return undefined;
    }
    return describeIdentity({ domain, stored: JSON.parse(contents.stdout) });
}

/** Gives a machine an identity it does not have yet, by generating one here and writing it there.

    The CA is self signed and never leaves that machine afterwards, so generating it here is only a
    convenience: what matters is that the private key ends up in one place and the id is the hash
    of its public half. */
export async function createRemoteIdentity(config: { host: string; domain: string }) {
    let { host, domain } = config;
    let generated = generateTestCA(domain);
    let stored: IdentityStorageType = {
        domain: generated.domain,
        certB64: generated.cert.toString("base64"),
        keyB64: generated.key.toString("base64"),
    };
    let home = (await runOverSSH({ host, script: `echo $HOME` })).stdout.trim();
    await writeRemoteFile({
        host,
        filePath: `${home}/${identityFileName(domain)}`,
        contents: JSON.stringify(stored),
        fileMode: "600",
        // The home directory is already there, this is only what it is created with if it is not.
        directoryMode: "700",
    });
    return describeIdentity({ domain, stored });
}

/** The raw ed25519 public key out of a certificate, which is what the machine id is a hash of. */
function publicKeyBytes(certPEM: string) {
    let spki = new crypto.X509Certificate(certPEM).publicKey.export({ type: "spki", format: "der" });
    // An ed25519 SPKI is a fixed 12 byte header followed by the 32 byte key.
    return spki.subarray(spki.length - 32);
}

export type TrustPacket = {
    machineId: string;
    certB64: string;
    signedAt: number;
    signatureB64: string;
};

/** Proves we hold the private key behind our machine id, right now. The signature covers the id
    and the time, so the packet cannot be replayed later or reused for another id. */
export async function signTrustPacket(domain: string): Promise<TrustPacket> {
    let { identity, stored } = await localIdentityKeys(domain);
    let signedAt = Date.now();
    let signature = crypto.sign(
        null,
        Buffer.from(`${identity.machineId} ${signedAt}`),
        crypto.createPrivateKey(Buffer.from(stored.keyB64, "base64").toString())
    );
    return {
        machineId: identity.machineId,
        certB64: stored.certB64,
        signedAt,
        signatureB64: signature.toString("base64"),
    };
}

/** Whether a packet really came from the machine it names. Says why when it did not, because
    "this is not that machine" and "this arrived too late" are different problems. */
export function verifyTrustPacket(packet: TrustPacket) {
    if (!packet || !packet.machineId || !packet.certB64 || !packet.signatureB64) {
        return { valid: false, problem: "the packet is missing fields" };
    }
    if (Math.abs(Date.now() - packet.signedAt) > PACKET_LIFETIME) {
        return { valid: false, problem: `it was signed ${Math.round((Date.now() - packet.signedAt) / 1000)}s ago` };
    }
    let certPEM = Buffer.from(packet.certB64, "base64").toString();
    let publicKey: crypto.KeyObject;
    try {
        publicKey = new crypto.X509Certificate(certPEM).publicKey;
    } catch (e) {
        return { valid: false, problem: `its certificate could not be read, ${e}` };
    }
    // The id is a hash of the public key, so this is what stops a machine claiming another's id.
    if (!verifyMachineIdForPublicKey({ machineId: packet.machineId, publicKey: publicKeyBytes(certPEM) })) {
        return { valid: false, problem: "the machine id does not belong to that certificate" };
    }
    let signed = crypto.verify(
        null,
        Buffer.from(`${packet.machineId} ${packet.signedAt}`),
        publicKey,
        Buffer.from(packet.signatureB64, "base64")
    );
    if (!signed) {
        return { valid: false, problem: "the signature does not check out" };
    }
    return { valid: true, problem: "" };
}
