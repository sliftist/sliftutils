/// <reference types="node" />
/// <reference types="node" />
/** A label mixed into a key's secret to get another key, so one key can stand behind several
    identities without any of them being stored.

    HMAC rather than hashing the two joined together: with a plain hash, anyone who obtained one
    derived key could extend it into further labels without ever knowing the source key. The label
    is the message and the source secret is the key, which is what HMAC is for. */
export declare function deriveEd25519Key(config: {
    seed: Buffer;
    label: string;
}): {
    seed: Buffer;
    publicKey: Buffer;
};
