import sha256 from "js-sha256";
import { isNode } from "socket-function/src/misc";
import { getCommonName, getIdentityCA, getMachineId, getThreadKeyCert, sign, validateCertificate, verify } from "../../misc/https/certs";
import { getTrustedMachines } from "./machines";

const MAX_SIGNED_AGE = 5 * 60 * 1000;

// A request says who it is from AND who it believes it is talking to. The "to" is whatever both
// sides use to identify the server - an IP, a machineId, a threadId - and being inside the signed
// payload is what stops a machine in the middle: a request addressed to someone else cannot be
// replayed at the real server, and the middleman cannot write requests of its own because it is
// not a trusted machine.
export type SignedRequest<T> = {
    signature: string;
    payload: {
        time: number;
        to: string;
        cert: string;
        certIssuer: string;
        data: T;
    };
};

// The reply echoes the request it answers, with the data collapsed to its hash - resending the
// data would say nothing the hash does not. Signed by the replying thread's certificate, which
// chains to its machine CA, which is where the machineId comes from.
export type SignedReply<T> = {
    signature: string;
    payload: {
        time: number;
        request: {
            time: number;
            to: string;
            cert: string;
            certIssuer: string;
            dataHash: string;
        };
        cert: string;
        certIssuer: string;
        data: T;
    };
};

function dataHash(data: unknown) {
    return sha256.sha256(JSON.stringify(data));
}

export function signRequest<T>(domain: string, config: { to: string; data: T }): SignedRequest<T> {
    let threadKeyCert = getThreadKeyCert(domain);
    let issuer = getIdentityCA(domain);
    let payload = {
        time: Date.now(),
        to: config.to,
        cert: threadKeyCert.cert.toString(),
        certIssuer: issuer.cert.toString(),
        data: config.data,
    };
    return { signature: sign(threadKeyCert, payload), payload };
}

/** Returns the machineId that signed, and the data. Throws if the signature, certificate chain,
    or time do not check out, or if the request was addressed to someone we are not: ownIdentities
    is every name this server answers to - its IPs (there are always several, internal and
    external), its machineId, its threadId - and the signed "to" must be one of them. */
export function verifyRequest<T>(domain: string, signed: SignedRequest<T>, ownIdentities: string[]): { machineId: string; data: T } {
    let { signature, payload } = signed;
    let signedThreshold = Date.now() - MAX_SIGNED_AGE;
    if (payload.time < signedThreshold) {
        throw new Error(`Signed request too old, ${payload.time} < ${signedThreshold}`);
    }
    verify(payload.cert, signature, payload);
    validateCertificate(domain, payload.cert, payload.certIssuer);
    if (!ownIdentities.includes(payload.to)) {
        throw new Error(`Request is for someone else. It is addressed to ${payload.to}, we are ${ownIdentities.join(", ")}`);
    }
    let machineId = getMachineId(getCommonName(payload.certIssuer), domain);
    return { machineId, data: payload.data };
}

export function signReply<T>(domain: string, request: SignedRequest<unknown>, data: T): SignedReply<T> {
    let threadKeyCert = getThreadKeyCert(domain);
    let issuer = getIdentityCA(domain);
    let payload = {
        time: Date.now(),
        request: {
            time: request.payload.time,
            to: request.payload.to,
            cert: request.payload.cert,
            certIssuer: request.payload.certIssuer,
            dataHash: dataHash(request.payload.data),
        },
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
    let echoed = payload.request;
    if (echoed.time !== request.payload.time
        || echoed.to !== request.payload.to
        || echoed.cert !== request.payload.cert
        || echoed.certIssuer !== request.payload.certIssuer
        || echoed.dataHash !== dataHash(request.payload.data)
    ) {
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
