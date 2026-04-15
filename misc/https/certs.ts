/// <reference path="./node-forge-ed25519.d.ts" />

module.allowclient = true;

// https://www.rfc-editor.org/rfc/rfc5280#page-42

import { setFlag } from "socket-function/require/compileFlags";
import * as forge from "node-forge";
import os from "os";
import fsSync from "fs";
import { cache, lazy } from "socket-function/src/caching";
import { isNode } from "socket-function/src/misc";
import sha265 from "js-sha256";
import crypto from "crypto";
import { trustCertificate } from "socket-function/src/certStore";
import { measureBlock, measureFnc, measureWrap } from "socket-function/src/profiling/measure";
import { getNodeIdDomain, getNodeIdDomainMaybeUndefined, getNodeIdLocation } from "socket-function/src/nodeCache";
import { MaybePromise } from "socket-function/src/types";
import { SocketFunction } from "socket-function/SocketFunction";
import { resetAllNodeCallFactories } from "socket-function/src/nodeCache";
import { getKeyStore } from "./persistentLocalStorage";

setFlag(require, "node-forge", "allowclient", true);
setFlag(require, "js-sha256", "allowclient", true);

const timeInDay = 1000 * 60 * 60 * 24;

export const CA_NOT_FOUND_ERROR = "18aa7318-f88f-4d2d-b41f-3daf4a433827";

export const identityStorageKey = "machineCA_10";
export type IdentityStorageType = { domain: string; certB64: string; keyB64: string };

function getIdentityStore(domain: string) {
    return getKeyStore<IdentityStorageType>(domain, identityStorageKey);
}

export interface X509KeyPair { domain: string; cert: Buffer; key: Buffer; }

export function getCommonName(cert: Buffer | string) {
    let subject = new crypto.X509Certificate(cert).subject;
    let subjectKVPs = new Map(subject.split(",").map(x => x.trim().split("=")).map(x => [x[0], x.slice(1).join("=")]));
    let commonName = subjectKVPs.get("CN");
    if (!commonName) throw new Error(`No common name in subject: ${subject}`);
    return commonName;
}

export function createX509(
    config: {
        domain: string;
        issuer: X509KeyPair | "self";
        lifeSpan: number;
        keyPair: {
            publicKey: forge.Ed25519PublicKey;
            privateKey: forge.Ed25519PrivateKey;
        } | forge.pki.KeyPair;
    }
): X509KeyPair {
    return measureBlock(function createX509() {
        let { domain, issuer, lifeSpan, keyPair } = config;

        let certObj = forge.pki.createCertificate();
        certObj.publicKey = keyPair.publicKey;
        certObj.serialNumber = "01";
        // Give it 5 minutes before now. If we give it too much time, it can look like the cert is really
        //  old, which will trigger various processes to try to get a fresher one (as if it lasts for
        //  1 hour, but we set notBefore to 1 month ago, it looks 1 month old, and so almost expired,
        //  when it isn't...)
        certObj.validity.notBefore = new Date(Date.now() - 1000 * 60 * 5);
        certObj.validity.notAfter = new Date(Date.now() + lifeSpan);

        const commonNameAttrs = [{ name: "commonName", value: domain }];
        certObj.setSubject(commonNameAttrs);

        if (issuer === "self") {
            certObj.setIssuer(commonNameAttrs);
        } else {
            certObj.setIssuer(forge.pki.certificateFromPem(issuer.cert.toString()).subject.attributes);
        }

        let extensions = [];
        const isCA = issuer === "self";
        if (isCA) {
            extensions.push({ name: "basicConstraints", cA: true });
        }

        let localHostDomain = "127-0-0-1." + domain.split(".").slice(-2).join(".");

        extensions.push(...[
            { name: "keyUsage", keyCertSign: isCA, digitalSignature: true, nonRepudiation: true, keyEncipherment: true, dataEncipherment: true },
            { name: "subjectKeyIdentifier" },
            {
                name: "subjectAltName",
                altNames: [
                    { type: 2, value: domain },
                    { type: 2, value: "*." + domain },
                    { type: 2, value: localHostDomain },
                    // NOTE: No longer allow 127.0.0.1, to make this more secure. We might enable this
                    //  behavior behind a flag, for development.
                    //{ type: 7, ip: "127.0.0.1" }
                ]
            },
            // NOTE: nameConstraints are supported with our branch. But... chrome doesn't support them, so there's no point in using them.
            //      "node-forge": "https://github.com/sliftist/forge#e618181b469b07bdc70b968b0391beb8ef5fecd6",
            // {
            //     name: "nameConstraints",
            //     permittedSubtrees: [
            //         // Chrome doesn't respect nameConstraints per https://bugs.chromium.org/p/chromium/issues/detail?id=1072083,
            //         //  as the spec decided that "free to process or ignore such information" (when present in self
            //         //  signed certificates), and therefore the chrome implementation decided "The first order is to behave predictably",
            //         //  so... they're not going to support it, because why have a feature in one place, if it isn't
            //         //  on android as well... ugh...
            //         // Works fine on Edge though
            //         { type: 2, value: forge.util.encodeUtf8(domain) },
            //         { type: 2, value: forge.util.encodeUtf8(localHostDomain) },
            //     ]
            // },
        ]);
        certObj.setExtensions(extensions);


        measureBlock(function sign() {
            if (issuer === "self") {
                certObj.sign(keyPair.privateKey as any, forge.md.sha256.create());
            } else {
                certObj.sign(privateKeyFromPem(issuer.key.toString()) as any, forge.md.sha256.create());
            }
        });

        return measureBlock(function toPems() {
            return {
                domain,
                cert: Buffer.from(forge.pki.certificateToPem(certObj)),
                key: Buffer.from(privateKeyToPem(keyPair.privateKey)),
            };
        });
    });
}
export function privateKeyToPem(buffer: forge.pki.PrivateKey | forge.Ed25519PrivateKey) {
    if ("privateKeyBytes" in buffer) {
        return forge.ed25519.privateKeyToPem(buffer);
    }
    return forge.pki.privateKeyToPem(buffer);
}
function privateKeyFromPem(pem: string) {
    // We want to guess the type correctly, as caught exceptions make debugging annoying
    if (pem.length < 200) {
        try {
            return forge.ed25519.privateKeyFromPem(pem);
        } catch { }
    }
    try {
        return forge.pki.privateKeyFromPem(pem);
    } catch {
        return forge.ed25519.privateKeyFromPem(pem);
    }
}
function publicKeyFromCert(cert: string) {
    return parseCert(cert).publicKey;
}
export function parseCert(PEMorDER: string | Buffer) {
    return forge.pki.certificateFromPem(normalizeCertToPEM(PEMorDER));
}

// Gets a unique value to represent the public key
export function getPublicIdentifier(PEMorDER: string | Buffer): Buffer {
    let obj = parseCert(PEMorDER);
    let publicKey = obj.publicKey;
    if ("publicKeyBytes" in publicKey) {
        return Buffer.from(publicKey.publicKeyBytes as any);
    }
    return Buffer.from(new Uint32Array((publicKey as any).n.data).buffer);
}

function isED25519(key: string | Buffer) {
    return key.length < 256;
}

// EQUIVALENT TO: `crypto.createSign("SHA256").update(JSON.stringify(payload)).sign(keyCert.key, "binary")`
export const sign = measureWrap(function sign(keyPair: { key: string | Buffer }, data: unknown): string {
    let dataStr = JSON.stringify(data);
    if (isED25519(keyPair.key)) {
        let privateKey = (forge.pki.ed25519 as any).privateKeyFromPem(keyPair.key.toString());
        return privateKey.sign(dataStr);
    } else {
        let privateKey = forge.pki.privateKeyFromPem(keyPair.key.toString());
        const md = forge.md.sha256.create();
        md.update(dataStr);
        return privateKey.sign(md);
    }
});

export function verify(cert: string, signature: string, data: unknown) {
    let certObj = parseCert(cert);
    return (certObj.publicKey as forge.pki.rsa.PublicKey).verify(JSON.stringify(data), signature);
}

function normalizeCertToPEM(PEMorDER: string | Buffer): string {
    if (PEMorDER.toString().startsWith("-----BEGIN CERTIFICATE-----")) {
        return PEMorDER.toString();
    }
    PEMorDER = PEMorDER.toString("base64");
    return "-----BEGIN CERTIFICATE-----\n" + PEMorDER + "\n-----END CERTIFICATE-----";
}

function getDomainPartFromPublicKey(publicKey: { publicKeyBytes: Buffer } | forge.pki.KeyPair["publicKey"] | Buffer) {
    let bytes: Buffer;
    if ("publicKeyBytes" in publicKey) {
        bytes = publicKey.publicKeyBytes;
    } else if (publicKey instanceof Buffer) {
        bytes = publicKey;
    } else {
        bytes = Buffer.from(new Uint32Array((publicKey as any).n.data).buffer);
    }
    return "b" + sha265.sha256(Buffer.from(bytes)).slice(0, 16).replaceAll("+", "-").replaceAll("/", "_");
}

export function validateCACert(domain: string, cert: string | Buffer) {
    let certParsed = parseCert(cert);

    let subject = certParsed.subject.getField("CN").value as string;
    let localhostDomain = "127-0-0-1." + subject.split(".").slice(-2).join(".");

    let domainParts = subject.split(".").reverse();

    let rootDomainParsed = [domainParts.shift(), domainParts.shift()].reverse().join(".");
    if (rootDomainParsed !== domain) {
        // This is important, as our trust store contains more then just OUR certificates,
        //  so if we allow any domains then real domains can impersonate anyone! It has to
        //  be one OUR domain to be trusted!
        throw new Error(`Certificate root domain should be ${domain}, but is ${rootDomainParsed}`);
    }
    // TODO: Maybe just skip if it isn't a hash string?
    if (domainParts[0] === "noproxy") {
        domainParts.shift();
    }

    let certExpectedPublicKeyPart = (domainParts.shift() || "").split("-").slice(-1)[0];
    let certActualPublicKeyPart = getDomainPartFromPublicKey(certParsed.publicKey);
    if (certExpectedPublicKeyPart !== certActualPublicKeyPart) {
        throw new Error(`Certificate public key in the url is ${certExpectedPublicKeyPart}, but in the cert is ${certActualPublicKeyPart}`);
    }

    // ALSO, require name constraints to be present, and to restrict to the "CN"
    let nameConstraints = certParsed.getExtension("nameConstraints") as any;
    if (!nameConstraints) {
        throw new Error(`Certificate must have nameConstraints`);
    }
    let subtrees = nameConstraints.permittedSubtrees;
    if (!subtrees) {
        throw new Error(`Certificate must have nameConstraints.permittedSubtrees`);
    }
    let subtreeValues = subtrees.map((x: any) => x.value);
    // Ignore localhostDomain, as it can always safely be allowed (the same machine
    //      is always allowed).
    subtreeValues = subtreeValues.filter((x: string) => x !== localhostDomain);
    if (subtreeValues.length !== 1 || subtreeValues[0] !== subject) {
        throw new Error(`Certificate must have a single constrained domain (had ${JSON.stringify(subtreeValues)})`);
    }

    validateAltNames(certParsed, subject);
}

export function validateCertificate(domain: string, cert: Buffer | string, issuerCert: Buffer | string) {
    validateCACert(domain, issuerCert);

    let certParsed = parseCert(cert);
    let subject = certParsed.subject.getField("CN").value as string;
    let localhostDomain = "127-0-0-1." + subject.split(".").slice(-2).join(".");

    let domainParts = subject.split(".").reverse();

    let rootDomainParsed = [domainParts.shift(), domainParts.shift()].reverse().join(".");
    if (rootDomainParsed !== domain) {
        throw new Error(`Certificate root domain should be ${domain}, but is ${rootDomainParsed}`);
    }
    // TODO: Maybe just skip if it isn't a hash string?
    if (domainParts[0] === "noproxy") {
        domainParts.shift();
    }

    let issuerCertParsed = parseCert(issuerCert);

    let issuerExpectedPublicKeyPart = domainParts.shift() || "";
    let issuerActualPublicKeyPart = getDomainPartFromPublicKey(issuerCertParsed.publicKey);
    if (issuerExpectedPublicKeyPart !== issuerActualPublicKeyPart) {
        throw new Error(`Issuer public key in the url is ${issuerExpectedPublicKeyPart}, but in the cert is ${issuerActualPublicKeyPart}`);
    }

    // Take the last part
    let certExpectedPublicKeyPart = domainParts.shift() || "";
    let certActualPublicKeyPart = getDomainPartFromPublicKey(certParsed.publicKey);
    if (certExpectedPublicKeyPart !== certActualPublicKeyPart) {
        throw new Error(`Certificate public key in the url is ${certExpectedPublicKeyPart}, but in the cert is ${certActualPublicKeyPart}`);
    }


    let nameConstraints = issuerCertParsed.getExtension("nameConstraints") as any;
    if (!nameConstraints) {
        throw new Error(`CA must have nameConstraints`);
    }
    let subtrees = nameConstraints.permittedSubtrees;
    if (!subtrees) {
        throw new Error(`CA must have nameConstraints.permittedSubtrees`);
    }
    let subtreeValues = subtrees.map((x: any) => x.value);
    // Ignore localhostDomain, as it can always safely be allowed (the same machine
    //      is always allowed).
    subtreeValues = subtreeValues.filter((x: string) => x !== localhostDomain);
    if (subtreeValues.length !== 1) {
        throw new Error(`CA must have a single constrained domain (had ${JSON.stringify(subtreeValues)})`);
    }

    let subtree = subtreeValues[0];
    if (subtree !== subject && !subject.endsWith("." + subtree)) {
        throw new Error(`Certificate must be a subtree of the CA (CA: ${subtree}, cert: ${subject})`);
    }

    validateAltNames(certParsed, subject);

    // Verify issuer ACTUALLY signed certParsed
    if (!issuerCertParsed.verify(certParsed)) {
        throw new Error(`Issuer did not sign certificate`);
    }
}

// Require alt names to be either equal to "CN", or a subtree of "CN"
function validateAltNames(certParsed: forge.pki.Certificate, subject: string) {
    let localhostDomain = "127-0-0-1." + subject.split(".").slice(-2).join(".");

    let altNamesObj = certParsed.getExtension("subjectAltName") as any;
    let altNames = altNamesObj?.altNames.map((x: any) => x.value);
    // Allow localhostDomain, as it can always safely be allowed
    altNames = altNames.filter((x: string) => x !== localhostDomain);
    if (
        altNames.some((x: string) =>
            !(
                x === subject
                || x.endsWith("." + subject)
                // Commented out, because... it is so easy to publish a 127.0.0.1 A record,
                //  and even to generate a real cert, so, we should jsut do that, and keep it secure.
                //  If we need this for development we can put it behind a flag, so non-development
                //  instances are still secure.
                // // Also allow 127.0.0.1, for local testing, for now?
                // //  - This might be insecure if these are trusted by the browser,
                // //      as then anyone that stores any cookies in this ip can have
                // //      the cookies stolen. But... if this is just cross-server...
                // //      I don't see how this could cause a security vulnerability.
                // || x === Buffer.from([127, 0, 0, 1]).toString()
            )
        )
    ) {
        throw new Error(`Invalid alt names. Must be subtrees of the subject (CN) ${JSON.stringify(subject)}, was ${JSON.stringify(altNames)}`);
    }
}


export function generateKeyPair() {
    return measureBlock(function generateKeyPair() {
        // NOTE: We use ED25519 because it can generated keys about 10X faster, WHICH, is still slow
        //  (~6ms on my machine). So we DEFINITELY don't want it to be 10X slower!
        // NOTE: ED25519 doens't have great support in browsers, but we shouldn't need self signed certificates
        //  in the browser anyway.
        //  - https://security.stackexchange.com/a/236943/282367
        //let keyPair = forge.ed25519.generateKeyPair();
        let keyPair = forge.pki.rsa.generateKeyPair();
        return keyPair;
    });
}
export function generateRSAKeyPair() {
    return measureBlock(function generateKeyPair() {
        return forge.pki.rsa.generateKeyPair();
    });
}

export function generateTestCA(domain: string) {
    const keyPair = generateKeyPair();
    let caPublicKeyPart = getDomainPartFromPublicKey(keyPair.publicKey);
    let fullDomain = `${caPublicKeyPart}.${domain}`;
    if (!isNode()) {
        fullDomain = `${caPublicKeyPart}.${domain}`;
    }

    return createX509({ domain: fullDomain, issuer: "self", keyPair, lifeSpan: timeInDay * 365 * 20 });
}

let identityCA = cache((domain: string) => {
    let identityCA = lazy((async (): Promise<X509KeyPair> => {
        let identityCACached = getIdentityStore(domain);
        let caCached = await identityCACached.get();
        if (!caCached) {
            console.log(`Generating new identity CA`);
            const keyPair = generateKeyPair();
            let caPublicKeyPart = getDomainPartFromPublicKey(keyPair.publicKey);
            let fullDomain = `${caPublicKeyPart}.${domain}`;
            if (!isNode()) {
                fullDomain = `${caPublicKeyPart}.${domain}`;
            }

            let value = createX509({ domain: fullDomain, issuer: "self", keyPair, lifeSpan: timeInDay * 365 * 20 });

            caCached = {
                domain: value.domain,
                certB64: value.cert.toString("base64"),
                keyB64: value.key.toString("base64"),
            };
            await identityCACached.set(caCached);
        }
        let result = {
            domain: caCached.domain,
            cert: Buffer.from(caCached.certB64, "base64"),
            key: Buffer.from(caCached.keyB64, "base64"),
        };
        trustCertificate(result.cert.toString());
        identityCA.set(result);
        return result;
    }) as (() => MaybePromise<X509KeyPair>));
    return identityCA;
});

// IMPORTANT! We do not embed any debug info in this domain. If we did, it would be useful,
//  but... potentally a security vulnerability, as if the debug info (such as a prefix)
//  is used to identify what a certificate is for, it would be easy for an attack to
//  forge this (as the debug info won't be secured). So it is much better to keep
//  the certificate opaque, and then require any metadata to be actually vetted
//  (and hopefully stored in a UI, showing IP, time, etc).
export function createCertFromCA(config: {
    CAKeyPair: X509KeyPair;
}): X509KeyPair {
    return measureBlock(function createCertFromCA() {
        let { CAKeyPair } = config;
        const keyPair = generateKeyPair();
        let domainKeyPart = getDomainPartFromPublicKey(keyPair.publicKey);
        let fullDomain = `${domainKeyPart}.${config.CAKeyPair.domain}`;
        return createX509({
            domain: fullDomain,
            issuer: CAKeyPair,
            keyPair,
            lifeSpan: timeInDay * 365 * 10,
        });
    });
}

export function getMachineId(domainName: string) {
    return domainName.split(".").slice(-3).join(".");
}

export type NodeIdParts = {
    threadId: string;
    machineId: string;
    domain: string;
    port: number;
};
export function decodeNodeId(nodeId: string): NodeIdParts | undefined {
    let locationObj = getNodeIdLocation(nodeId);
    if (!locationObj) {
        return undefined;
    }
    let parts = locationObj.address.split(".");
    if (nodeId.startsWith("127-0-0-1.") && parts.length === 3) {
        return {
            threadId: "",
            machineId: parts.at(-3) || "",
            domain: parts.slice(-2).join("."),
            port: locationObj.port,
        };
    }
    if (parts.length < 4) {
        return undefined;
    }
    return {
        threadId: parts.at(-4) || "",
        machineId: parts.at(-3) || "",
        domain: parts.slice(-2).join(".") || "",
        port: locationObj.port,
    };
}
export function decodeNodeIdAssert(nodeId: string): NodeIdParts {
    let result = decodeNodeId(nodeId);
    if (!result) {
        throw new Error(`Invalid nodeId: ${nodeId}`);
    }
    return result;
}
export function encodeNodeId(parts: NodeIdParts) {
    return `${parts.threadId}.${parts.machineId}.${parts.domain}:${parts.port}`;
}

export async function setIdentityCARaw(domain: string, json: string) {
    let identityCACached = getIdentityStore(domain);
    let obj = JSON.parse(json) as {
        domain: string;
        certB64: string;
        keyB64: string;
    };
    let ca = {
        domain: obj.domain,
        cert: Buffer.from(obj.certB64, "base64"),
        key: Buffer.from(obj.keyB64, "base64"),
    };
    trustCertificate(ca.cert.toString());
    identityCA(domain).set(ca);
    getThreadKeyCertBase(domain).reset();
    await identityCACached.set(obj);
    resetAllNodeCallFactories();
}

export async function loadIdentityCA(domain: string) {
    await identityCA(domain)();
}
export function getIdentityCA(domain: string): X509KeyPair {
    let value = identityCA(domain)();
    if (value instanceof Promise) {
        throw new Error("Identity CA is not yet loaded. Call and wait for loadIdentityCA() in your startup before accessing the identity (or call getIdentityCAPromise())");
    }
    return value;
}

// TODO: Replace this with a database, so it is easy for us to trust CAs
//  cross machine, and even have multiple users, etc, etc.
export function getIdentityCAPromise(domain: string): MaybePromise<X509KeyPair> {
    return identityCA(domain)();
}


export function getOwnMachineId(domain: string) {
    return getMachineId(getIdentityCA(domain).domain);
}

/** Part of the machineId comes from the publicKey, so we can use it to verify */
export function verifyMachineIdForPublicKey(config: {
    machineId: string;
    publicKey: Buffer;
}): boolean {
    let { machineId, publicKey } = config;
    let domainPart = getDomainPartFromPublicKey(publicKey);
    return machineId.split(".").at(-3) === domainPart;
}

// NOTE: We don't have a cache per CA, as... the CA should be set first
//  TODO: Maybe throw if they try to change the CA after they generate any certificates?
// TODO: Regenerate certificates after enough time (as thread certs should be relatively short lived,
//  so it is plausible for them to expire)
//  - We will also need to provide a callback so that users of the cert can update the cert they
//      are using as well.
export function getThreadKeyCert(domain: string) {
    return getThreadKeyCertBase(domain)();
}
const getThreadKeyCertBase = cache((domain: string) => lazy(() => {
    let ca = getIdentityCA(domain);
    return createCertFromCA({ CAKeyPair: ca });
}));

export const createTestBrowserKeyCert = lazy(async () => {
    let keyPair = generateRSAKeyPair();
    return await createX509({ domain: "test", issuer: "self", keyPair, lifeSpan: timeInDay * 365 * 20 });
});

export function getOwnNodeId(): string {
    let nodeId = SocketFunction.mountedNodeId;
    if (!nodeId) {
        throw new Error(`Node must be mounted before nodeId is accessed`);
    }
    return nodeId;
}

export function getOwnNodeIdAllowUndefined() {
    return SocketFunction.mountedNodeId;
}