import sha256 from "js-sha256";
import { isNode } from "socket-function/src/misc";
import { secureRandomHex } from "../../misc/random";
import { getCommonName, getIdentityCA, getMachineId, getThreadKeyCert, sign, validateCertificate, verify } from "../../misc/https/certs";
import { getTrustedMachines } from "./machines";

const MAX_SIGNED_AGE = 5 * 60 * 1000;
// Clocks disagree, so a payload from slightly ahead is normal - but one from far ahead would
// never age out, and so would never stop being accepted.
const MAX_SIGNED_FUTURE = 60 * 60 * 1000;
const NONCE_BYTES = 16;
// Nonces of the requests we have accepted, so none of them can be replayed. Cleared wholesale at
// the limit rather than expired one by one: reaching it takes a million signed requests inside
// the five minute window, which is a server being hammered - something we would notice for other
// reasons - and all it buys is one replay of one request.
const MAX_SEEN_NONCES = 1000 * 1000;
let seenNonces = new Set<string>();

export type SignedRequest<T> = {
    signature: string;
    payload: {
        // When it was signed - anything older than MAX_SIGNED_AGE is refused
        time: number;
        // Who the sender believes it is talking to: an IP, a machineId, a threadId - whatever
        // both sides use to name the server. Being inside the signed payload is what stops a
        // machine in the middle: a request addressed to someone else cannot be replayed at the
        // real server, and the middleman cannot write requests of its own because it is not a
        // trusted machine.
        targetId: string;
        targetIsMachineId?: boolean;
        // Makes the request one use only - the server refuses a nonce it has already accepted
        nonce: string;
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
        time: number;
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

function assertSignedTime(kind: string, time: number) {
    let oldest = Date.now() - MAX_SIGNED_AGE;
    if (time < oldest) {
        throw new Error(`Signed ${kind} is too old, ${time} < ${oldest}`);
    }
    let newest = Date.now() + MAX_SIGNED_FUTURE;
    if (time > newest) {
        throw new Error(`Signed ${kind} is too far in the future, ${time} > ${newest}`);
    }
}

export function signRequest<T>(domain: string, config: { targetId: string; targetIsMachineId?: boolean; data: T }): SignedRequest<T> {
    let threadKeyCert = getThreadKeyCert(domain);
    let issuer = getIdentityCA(domain);
    let payload: SignedRequest<T>["payload"] = {
        time: Date.now(),
        targetId: config.targetId,
        targetIsMachineId: config.targetIsMachineId,
        nonce: secureRandomHex(NONCE_BYTES),
        cert: threadKeyCert.cert.toString(),
        certIssuer: issuer.cert.toString(),
        data: config.data,
    };
    return { signature: sign(threadKeyCert, payload), payload };
}

/** Returns the machineId that signed, the data, and the signed reply to send back - always
    produced, so the caller's only job is to return it. Throws if the signature, certificate
    chain, or time do not check out, or if the request was addressed to someone we are not:
    ownIdentities is every name this server answers to - its IPs (there are always several,
    internal and external), its machineId, its threadId - and the signed targetId must be one of
    them.

    IMPORTANT! You still need to check the machine with isMachineAccepted if you want to know if
    the machine is trusted. We just verify that they are who they say they are, not that who they
    say they are is allowed. */
export function verifyRequest<T>(domain: string, signed: SignedRequest<T>, ownIdentities: string[]): {
    machineId: string;
    data: T;
    reply: SignedReply;
} {
    let { signature, payload } = signed;
    assertSignedTime("request", payload.time);
    verify(payload.cert, signature, payload);
    validateCertificate(domain, payload.cert, payload.certIssuer);
    if (!ownIdentities.includes(payload.targetId)) {
        throw new Error(`Request is for someone else. It is addressed to ${payload.targetId}, we are ${ownIdentities.join(", ")}`);
    }
    // After the signature, so only a real signer can take up a slot
    if (seenNonces.has(payload.nonce)) {
        throw new Error(`Request ${payload.nonce} was already used, so it is being refused as a replay`);
    }
    if (seenNonces.size >= MAX_SEEN_NONCES) {
        seenNonces.clear();
    }
    seenNonces.add(payload.nonce);
    let machineId = getMachineId(getCommonName(payload.certIssuer), domain);
    let threadKeyCert = getThreadKeyCert(domain);
    let issuer = getIdentityCA(domain);
    let { data: requestData, ...requestRest } = payload;
    let replyPayload: SignedReply["payload"] = {
        time: Date.now(),
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

/** Returns the machineId that replied. Throws if the signature, certificate chain, or time do
    not check out, or if the reply does not answer the request we actually sent. When the request
    said targetIsMachineId, the machine that replied must be the machine the request was
    addressed to. On node the replying machine must also be one of the trusted machines - the
    browser has no machine list, so there that check is skipped. */
export async function verifyReply(domain: string, request: SignedRequest<unknown>, reply: SignedReply): Promise<{ machineId: string }> {
    let { signature, payload } = reply;
    assertSignedTime("reply", payload.time);
    verify(payload.cert, signature, payload);
    validateCertificate(domain, payload.cert, payload.certIssuer);
    let { data: requestData, ...requestRest } = request.payload;
    let { dataHash: echoedHash, ...echoedRest } = payload.request;
    if (echoedHash !== dataHash(requestData) || JSON.stringify(echoedRest) !== JSON.stringify(requestRest)) {
        throw new Error(`Reply answers a different request than the one we sent`);
    }
    let machineId = getMachineId(getCommonName(payload.certIssuer), domain);
    if (request.payload.targetIsMachineId && machineId !== request.payload.targetId) {
        throw new Error(`Reply is from machine ${machineId}, but the request was addressed to machine ${request.payload.targetId}`);
    }
    if (isNode()) {
        if (!(await getTrustedMachines()).some(machine => machine.machineId === machineId)) {
            throw new Error(`Reply is signed by ${machineId}, which is not a trusted machine`);
        }
    }
    return { machineId };
}
