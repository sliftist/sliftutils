/*
    NOTE: This whole verification process isn't secure if someone man-in-the-middles the IP. There is a way to make it more secure, but right now it is quite a bit of work. Here is the outline, though. 

    a) Use libsodium, do handshake ourself over unsecured websocket (or random self signed websocket), and use ChaCha20 for encryption so it's fast
        - This lets us use ED25519 certificates. 
    b) Integrate with socket-function, So we can do everything with regular socket function calls. It's a lot nicer of an interface. We can even have it proxied to Python. As annoying as that is...
    c) Use github pages to host the site, so we can also host the machine keys
        - Every time they change, we need to redeploy, and... we don't get revocations without deploying. BUT... it's better than nothing.

    NOTE: Just using real HTTPS certificates isn't really an alternative.
        - They won't be bound to IPs
        - Revoking them is a lot more difficult (and they won't be automatically revoked)
        - Once you reach certain level of machines, you're going to run into problems with different certificates per machine
        - You're still going to need a way to give servers access to either the certificates or a way to generate the certificates.

    So doing it with our own code isn't about cost or difficulty. The reason we would want to implement it ourselves is because HTTPS wasn't made to create an internal network of trust. It's designed around web browsing, and it works well for that. However, for two-way authentication, there are significantly better systems.
*/

import sha256 from "js-sha256";
import { isNode } from "socket-function/src/misc";
import { getCommonName, getIdentityCA, getMachineId, getThreadKeyCert, sign, validateCertificate, verify } from "../../misc/https/certs";
import { getTrustedMachines } from "./machines";

export type SignedRequest<T> = {
    signature: string;
    payload: {
        // Who the sender believes it is talking to, which should be the resolved IP it dialed.
        // Being inside the signed payload scopes the request to that one server, and an IP scopes
        // it better than any name does: an attacker who takes the IP takes it FROM us, so no
        // legitimate machine answers to it any more and the request they intercepted validates
        // nowhere - and rewriting it to name a machine that would accept it breaks the signature.
        // A hostname or a machineId is still legitimately held by the real machine, so a request
        // naming one can be forwarded there and used.
        targetId: string;
        // The thread certificate that signed this
        cert: string;
        // The machine CA that issued cert - the machineId comes from its common name
        certIssuer: string;
        data: T;
    };
};

export type SignedReply = {
    signature: string;
    payload: {
        // The request this reply answers, with the data collapsed to its hash - resending the
        // data would say nothing the hash does not
        request: Omit<SignedRequest<unknown>["payload"], "data"> & { dataHash: string };
        cert: string;
        certIssuer: string;
    };
};

function dataHash(data: unknown) {
    return sha256.sha256(JSON.stringify(data));
}

export function signRequest<T>(domain: string, config: { targetId: string; data: T }): SignedRequest<T> {
    let threadKeyCert = getThreadKeyCert(domain);
    let issuer = getIdentityCA(domain);
    let payload: SignedRequest<T>["payload"] = {
        targetId: config.targetId,
        cert: threadKeyCert.cert.toString(),
        certIssuer: issuer.cert.toString(),
        data: config.data,
    };
    return { signature: sign(threadKeyCert, payload), payload };
}

/** Returns the machineId that signed, the data, and the signed reply to send back - always
    produced, so the caller's only job is to return it. Throws if the signature or certificate
    chain do not check out, or if the request was addressed to someone we are not: ownIdentities
    is every address this server answers to - there are always several, internal and external -
    and the signed targetId must be one of them.

    IMPORTANT! You still need to check the machine with isMachineAccepted if you want to know if
    the machine is trusted. We just verify that they are who they say they are, not that who they
    say they are is allowed. */
export function verifyRequest<T>(domain: string, signed: SignedRequest<T>, ownIdentities: string[]): {
    machineId: string;
    data: T;
    reply: SignedReply;
} {
    let { signature, payload } = signed;
    verify(payload.cert, signature, payload);
    validateCertificate(domain, payload.cert, payload.certIssuer);
    if (!ownIdentities.includes(payload.targetId)) {
        throw new Error(`Request is for someone else. It is addressed to ${payload.targetId}, we are ${ownIdentities.join(", ")}`);
    }
    let machineId = getMachineId(getCommonName(payload.certIssuer), domain);
    let threadKeyCert = getThreadKeyCert(domain);
    let issuer = getIdentityCA(domain);
    let { data: requestData, ...requestRest } = payload;
    let replyPayload: SignedReply["payload"] = {
        request: { ...requestRest, dataHash: dataHash(requestData) },
        cert: threadKeyCert.cert.toString(),
        certIssuer: issuer.cert.toString(),
    };
    return {
        machineId,
        data: payload.data,
        reply: { signature: sign(threadKeyCert, replyPayload), payload: replyPayload },
    };
}

/** Returns the machineId that replied. Throws if the signature or certificate chain do not check
    out, or if the reply does not answer the request we actually sent. On node the replying
    machine must also be one of the trusted machines - the browser has no machine list, so there
    that check is skipped. */
export async function verifyReply(domain: string, request: SignedRequest<unknown>, reply: SignedReply): Promise<{ machineId: string }> {
    let { signature, payload } = reply;
    verify(payload.cert, signature, payload);
    validateCertificate(domain, payload.cert, payload.certIssuer);
    let { data: requestData, ...requestRest } = request.payload;
    let { dataHash: echoedHash, ...echoedRest } = payload.request;
    if (echoedHash !== dataHash(requestData) || JSON.stringify(echoedRest) !== JSON.stringify(requestRest)) {
        throw new Error(`Reply answers a different request than the one we sent`);
    }
    let machineId = getMachineId(getCommonName(payload.certIssuer), domain);
    if (isNode()) {
        if (!(await getTrustedMachines()).some(machine => machine.machineId === machineId)) {
            throw new Error(`Reply is signed by ${machineId}, which is not a trusted machine`);
        }
    }
    return { machineId };
}
