/// <reference types="node" />
/// <reference types="node" />
export declare const UNSIGNED = "";
/** Whether an identity - a key fingerprint or a machine id - has a revocation nothing has undone.
    The one meaning of "frozen", used both when stripping repo content and when explaining why. */
export declare function isIdentityFrozen(identity: string): boolean;
export declare function isPairRevoked(identity: string, ip: string): boolean;
export declare function isPairUnrevoked(identity: string, ip: string): boolean;
/** For whoever just wrote a revocation, so it holds here immediately rather than on the next
    absorb. Sticky like the rest. */
export declare function noteRevocation(revocationId: string, identity: string, ip: string): void;
/** A repo that cannot be trusted, with the message ready for whoever asked. Not every caller
    treats these the same - a source keeps its last keys, a machine list is just refused - so the
    kind is carried rather than acted on here. */
export declare class SignedRepoError extends Error {
    problem: string;
    headline: string;
    body: string;
    constructor(problem: string, headline: string, body: string);
}
/** Everything a signed checkout vouches for, in one call: who signed it, and the contents of every
    file the signature actually covers.

    UNSIGNED with no files when there is no signature at all. Throws a SignedRepoError when a
    signature is present but does not hold up, or when a file it signed for was changed or removed
    without re-signing - either way the caller keeps whatever it last accepted rather than believing
    a repo that no longer matches what was signed. A file not in the manifest is just unsigned, so
    it is left out and warned about rather than treated as tampering. */
export declare function readSignedRepo(config: {
    repoPath: string;
    sourceURL: string;
}): Promise<{
    signer: string;
    manifestHash: string;
    signatureHash: string;
    files: Map<string, Buffer>;
}>;
