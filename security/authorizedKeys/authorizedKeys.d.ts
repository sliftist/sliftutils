export declare function normalizeKeys(contents: string): string[];
/** The fingerprint ssh itself reports for a key, which is what the sshd log names and therefore
    what a revocation is keyed by. Returns "" for a line that holds no key. */
export declare function keyFingerprint(keyLine: string): string;
export declare const NO_RESTRICTION = "ANY ADDRESS (no from= restriction)";
/** The addresses a key may be used from, one by one, or undefined when the key carries no from=
    at all. Undefined and an empty list are very different things, so they stay distinguishable. */
export declare function keyRestrictionList(keyLine: string): string[] | undefined;
/** The addresses a key may be used from, which is the part of an authorized_keys line that
    decides how much a stolen key is worth. A key with no restriction says so loudly. */
export declare function keyRestriction(keyLine: string): string;
/** Adds addresses to a key's from= list, leaving the rest of the line exactly as it was. Returns
    which addresses were actually new, so a caller can report only what it changed.

    A key with no from= at all is left alone: adding one would silently restrict a key that is
    currently unrestricted, which is a different decision than the one being made here. */
export declare function allowAddresses(keyLine: string, addresses: string[]): {
    keyLine: string;
    added: string[];
};
/** Enough to recognise whose key this is without printing the whole blob. */
export declare function summarizeKey(keyLine: string): string;
/** The shortest thing that still identifies a key to a person: the comment it carries, which is
    usually user@machine, and otherwise the tail of the key itself. For the first line of a
    notification, where there is only room for the one thing that matters. */
export declare function keyNiceName(keyLine: string): string;
/** What a set of keys has to satisfy before it is worth signing, as a list of complaints.

    Every key needs a from=, because an unrestricted key can never be caught being used from the
    wrong place, and being caught is the only thing that triggers a revocation.

    No two keys may allow the same addresses, because that is one person holding two keys: revoking
    one of them leaves the other working, so the revocation achieves nothing. */
export declare function findKeyProblems(keys: string[]): string[];
/** Reads the authorized keys a repo checkout wants applied. Prefers a top level authorized_keys
    file and otherwise concatenates every .pub at the top level. */
export declare function readRepoKeys(repoPath: string): Promise<string[]>;
