/// <reference types="node" />
/// <reference types="node" />
export declare const UNSIGNED = "";
export type Revocation = {
    identity: string;
    ip: string;
    revokedAt: string;
    revokedBy: string;
};
/** The revocation freezing an identity - a key fingerprint or a machine id - or nothing if it is
    not frozen. The one meaning of "frozen", used both when stripping repo content and when
    explaining why, and it hands back the revocation rather than a bare yes so that whoever has to
    explain it can say which address it was, and when, instead of "an unapproved address". */
export declare function identityFrozenBy(identity: string): {
    revocationId: string;
    identity: string;
    ip: string;
    revokedAt: string;
    revokedBy: string;
} | undefined;
/** Every revocation this process has absorbed, and whether an unrevoke has since forgiven it. For
    anything showing the whole picture rather than asking about one identity. */
export declare function listRevocations(): {
    revocationId: string;
    forgiven: boolean;
    identity: string;
    ip: string;
    revokedAt: string;
    revokedBy: string;
}[];
export declare function isPairRevoked(identity: string, ip: string): boolean;
export declare function isPairUnrevoked(identity: string, ip: string): boolean;
/** For whoever just wrote a revocation, so it holds here immediately rather than on the next
    absorb. Sticky like the rest. */
export declare function noteRevocation(revocationId: string, revocation: Revocation): void;
/** A repo whose signature does not check out, with the message ready for whoever asked. Not every
    caller treats it the same - a source keeps its last keys, a machine list is just refused - so
    the kind is carried rather than acted on here. */
export declare class SignedRepoError extends Error {
    problem: string;
    headline: string;
    body: string;
    constructor(problem: string, headline: string, body: string);
}
/** Everything a signed checkout vouches for, in one call: who signed it, and the contents of every
    file the signature actually covers.

    UNSIGNED with no files when there is no signature at all. Throws a SignedRepoError only when the
    signature over the manifest does not hold up, since then nothing in the repo can be believed and
    the caller keeps whatever it last accepted.

    Individual files are included or left out one at a time, and a file being left out never affects
    the others: a file the manifest does not name, a file whose contents no longer match what was
    signed, and a file the manifest names that is not on disk are all simply files we hold no
    signature for. */
export declare function readSignedRepo(config: {
    repoPath: string;
    sourceURL: string;
}): Promise<{
    signer: string;
    manifestHash: string;
    signatureHash: string;
    files: Map<string, Buffer>;
}>;
