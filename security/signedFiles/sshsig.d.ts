/// <reference types="node" />
/// <reference types="node" />
/** Verifies an SSHSIG signature over a message, and that it was made for the given namespace.
    Returns the signing public key and its fingerprint, in the forms ssh-keygen reports them.
    Throws if it does not verify, or is not for this namespace. */
export declare function verifySSHSIG(config: {
    signature: string;
    message: Buffer;
    namespace: string;
}): {
    publicKey: string;
    fingerprint: string;
};
