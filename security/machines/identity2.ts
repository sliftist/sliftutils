import { getCommonName, getIdentityCA, getMachineId, getThreadKeyCert, sign, validateCertificate, verify } from "../../misc/https/certs";

const MAX_SIGNED_AGE = 5 * 60 * 1000;

export type SignedPayload<T> = {
    signature: string;
    payload: {
        time: number;
        cert: string;
        certIssuer: string;
        data: T;
    };
};

export function signAsMachine<T>(domain: string, data: T): SignedPayload<T> {
    let threadKeyCert = getThreadKeyCert(domain);
    let issuer = getIdentityCA(domain);
    let payload = {
        time: Date.now(),
        cert: threadKeyCert.cert.toString(),
        certIssuer: issuer.cert.toString(),
        data,
    };
    return { signature: sign(threadKeyCert, payload), payload };
}

/** Returns the machineId that signed, and the data. Throws if the signature, certificate chain,
    or time do not check out. */
export function verifyMachineSigned<T>(domain: string, signed: SignedPayload<T>): { machineId: string; data: T } {
    let { signature, payload } = signed;
    let signedThreshold = Date.now() - MAX_SIGNED_AGE;
    if (payload.time < signedThreshold) {
        throw new Error(`Signed payload too old, ${payload.time} < ${signedThreshold}`);
    }
    verify(payload.cert, signature, payload);
    validateCertificate(domain, payload.cert, payload.certIssuer);
    let machineId = getMachineId(getCommonName(payload.certIssuer), domain);
    return { machineId, data: payload.data };
}
