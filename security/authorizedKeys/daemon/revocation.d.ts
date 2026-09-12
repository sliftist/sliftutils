export type Attempt = {
    ip: string;
    user: string;
    port: string;
    required: string;
    line: string;
};
/** What an unrevoke has to name to undo a revocation, and what stops a second revocation of the
    same key from the same address. */
export declare function pairKey(config: {
    fingerprint: string;
    ip: string;
}): string;
/** Unique to the event. The time is there to read, the random half is there to be unique. */
export declare function newRevocationId(fingerprint: string): string;
export type RevocationFile = {
    revocationId: string;
    fingerprint: string;
    ip: string;
    revokedAt: string;
    revokedBy: string;
    reason: string;
};
export declare function readRevocationFiles(sourceURL: string): Promise<RevocationFile[]>;
/** Which key is allowed from which address. Unrevokes live in the source repo, so they are covered
    by its signature, and nothing is read out of them but the pairs they allow and, for files
    written before pairs existed, the revocation ids they name. */
export type Unrevokes = {
    pairs: Map<string, string[]>;
    legacyIds: Map<string, string[]>;
};
export declare function readUnrevokes(sourceURL: string): Promise<Unrevokes>;
/** Every unrevoke covering one revocation: by the pair it is about, and by its id for the files
    written before pairs existed. */
export declare function unrevokesFor(unrevokes: Unrevokes, revocation: {
    revocationId: string;
    fingerprint: string;
    ip: string;
}): string[];
/** Writes a revocation, unless this key is already revoked for this address. Checked twice:
    against what this machine already knows, which needs no network, and again against the repo
    after pulling it, so a flood of unknown keys cannot turn into a flood of commits.

    Deduplication is on the pair. The same key from a second address is a second event and gets its
    own revocation, because an unrevoke only ever forgives the pair it names. */
export declare function recordRevocation(config: {
    sourceURL: string;
    fingerprint: string;
    keyLine: string;
    attempt: Attempt;
    hostLabel: string;
}): Promise<boolean>;
/** Takes everything the revoke repos list into local state. Once here a revocation never leaves,
    even if the file is deleted: the key that writes revocations is on every server, so an attacker
    holding it could otherwise erase the record that locked them out. */
export declare function absorbRevocations(sourceURLs: string[]): Promise<void>;
/** An unrevoke counts the moment it is seen.

    There used to be an hour's wait before honouring one, against a signing key that had itself
    been stolen. It was never worth it: an unrevoke has to be signed, so writing one already takes
    the hardware key, and anyone holding that can sign a new authorized_keys naming whatever they
    like - they have no reason to go near an unrevoke. Meanwhile the wait cost real access, and a
    machine deployed after an incident would freeze keys it had never had a problem with, for an
    hour, because it was seeing the unrevoke for the first time.

    What still protects a stolen signing key is the 24 hours before a NEW signer is accepted. */
export declare function applyUnrevokes(sourceURLs: string[]): Promise<void>;
/** Reports each revocation the first time it actually takes a key out of this machine's file. The
    dropping itself happens in readSignedRepo, which strips revoked keys before anything reads them
    - this only says so, and kills whatever sessions the key was holding open. */
export declare function reportRevokedKeys(): Promise<void>;
