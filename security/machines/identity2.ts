import sha256 from "js-sha256";
import { isNode } from "socket-function/src/misc";
import { getCommonName, getIdentityCA, getMachineId, getThreadKeyCert, sign, validateCertificate, verify } from "../../misc/https/certs";
import { getTrustedMachines } from "./machines";

const MAX_SIGNED_AGE = 5 * 60 * 1000;

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
        // The thread certificate that signed this
        cert: string;
        // The machine CA that issued cert - the machineId comes from its common name
        certIssuer: string;
        data: T;
    };
};

export type SignedReply<T> = {
    signature: string;
    payload: {
        time: number;
        // The request this reply answers, with the data collapsed to its hash - resending the
        // data would say nothing the hash does not
        request: Omit<SignedRequest<unknown>["payload"], "data"> & { dataHash: string };
        cert: string;
        certIssuer: string;
        data: T;
    };
};

function dataHash(data: unknown) {
    return sha256.sha256(JSON.stringify(data));
}

export function signRequest<T>(domain: string, config: { targetId: string; data: T }): SignedRequest<T> {
    let threadKeyCert = getThreadKeyCert(domain);
    let issuer = getIdentityCA(domain);
    let payload: SignedRequest<T>["payload"] = {
        time: Date.now(),
        targetId: config.targetId,
        cert: threadKeyCert.cert.toString(),
        certIssuer: issuer.cert.toString(),
        data: config.data,
    };
    return { signature: sign(threadKeyCert, payload), payload };
}

/** Returns the machineId that signed, and the data. Throws if the signature, certificate chain,
    or time do not check out, or if the request was addressed to someone we are not: ownIdentities
    is every name this server answers to - its IPs (there are always several, internal and
    external), its machineId, its threadId - and the signed targetId must be one of them. */
export function verifyRequest<T>(domain: string, signed: SignedRequest<T>, ownIdentities: string[]): { machineId: string; data: T } {
    let { signature, payload } = signed;
    let signedThreshold = Date.now() - MAX_SIGNED_AGE;
    if (payload.time < signedThreshold) {
        throw new Error(`Signed request too old, ${payload.time} < ${signedThreshold}`);
    }
    verify(payload.cert, signature, payload);
    validateCertificate(domain, payload.cert, payload.certIssuer);
    if (!ownIdentities.includes(payload.targetId)) {
        throw new Error(`Request is for someone else. It is addressed to ${payload.targetId}, we are ${ownIdentities.join(", ")}`);
    }
    let machineId = getMachineId(getCommonName(payload.certIssuer), domain);
    return { machineId, data: payload.data };
}

export function signReply<T>(domain: string, request: SignedRequest<unknown>, data: T): SignedReply<T> {
    let threadKeyCert = getThreadKeyCert(domain);
    let issuer = getIdentityCA(domain);
    let { data: requestData, ...requestRest } = request.payload;
    let payload: SignedReply<T>["payload"] = {
        time: Date.now(),
        request: { ...requestRest, dataHash: dataHash(requestData) },
        cert: threadKeyCert.cert.toString(),
        certIssuer: issuer.cert.toString(),
        data,
    };
    return { signature: sign(threadKeyCert, payload), payload };
}

/** Returns the machineId that replied, and the data. Throws if the signature, certificate chain,
    or time do not check out, or if the reply does not answer the request we actually sent. On
    node the replying machine must also be one of the trusted machines - the browser has no
    machine list, so there this check is skipped. */
export async function verifyReply<T>(domain: string, request: SignedRequest<unknown>, reply: SignedReply<T>): Promise<{ machineId: string; data: T }> {
    let { signature, payload } = reply;
    let signedThreshold = Date.now() - MAX_SIGNED_AGE;
    if (payload.time < signedThreshold) {
        throw new Error(`Signed reply too old, ${payload.time} < ${signedThreshold}`);
    }
    verify(payload.cert, signature, payload);
    validateCertificate(domain, payload.cert, payload.certIssuer);
    let { data: requestData, ...requestRest } = request.payload;
    let expected: SignedReply<T>["payload"]["request"] = { ...requestRest, dataHash: dataHash(requestData) };
    if (JSON.stringify(payload.request) !== JSON.stringify(expected)) {
        throw new Error(`Reply answers a different request than the one we sent`);
    }
    let machineId = getMachineId(getCommonName(payload.certIssuer), domain);
    if (isNode()) {
        if (!(await getTrustedMachines()).some(machine => machine.machineId === machineId)) {
            throw new Error(`Reply is signed by ${machineId}, which is not a trusted machine`);
        }
    }
    return { machineId, data: payload.data };
}
