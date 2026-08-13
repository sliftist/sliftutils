/// <reference types="node" />
/// <reference types="node" />
/** The public key of a seed, worked out by node rather than by reimplementing the curve. */
export declare function publicKeyFromSeed(seed: Buffer): Buffer;
export declare function parseOpenSSHPrivateKey(contents: string): {
    seed: Buffer;
    publicKey: Buffer;
    comment: string;
};
export declare function formatOpenSSHPrivateKey(config: {
    seed: Buffer;
    comment: string;
}): string;
/** The single line form, as it appears in authorized_keys and in a .pub file. */
export declare function formatPublicKeyLine(config: {
    publicKey: Buffer;
    comment: string;
}): string;
