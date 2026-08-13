/** What we last decided to trust for one source, kept on disk so nobody can tell us a different
    story about what we saw last time. */
export type SourceState = {
    lastSha: string;
    branch: string;
    accepted: boolean;
    acceptedSigner: string;
    acceptedKeys: string[];
    acceptedManifestHash: string;
    acceptedSignatureHash: string;
    pendingSigner: string;
    pendingSince: number;
    reportedProblem: string;
};
/** One revocation event: this key, used from this address, so it is no longer accepted. Kept even
    when the revoke repo no longer lists it: the deploy key that writes revocations lives on every
    server, so an attacker who took one could otherwise delete the revocation that locked them out.

    The id is unique to the event, never derived from the key. A key that has been forgiven for one
    address is still an ordinary key, and using it from some other address revokes it again, with a
    new id that no existing unrevoke names. */
export type RevocationState = {
    revocationId: string;
    fingerprint: string;
    ip: string;
    revokedAt: string;
    revokedBy: string;
    reason: string;
    unrevokeId: string;
    unrevoked: boolean;
    reportedRemoved: boolean;
};
/** A refusal we saw but could not write down yet. Held until it is recorded, because the log is
    read once and moves on: losing one of these to a repo that happened to be unreachable would
    leave a key that was misused accepted forever. */
export type PendingRevocation = {
    fingerprint: string;
    keyLine: string;
    sourceURL: string;
    attempt: {
        ip: string;
        user: string;
        port: string;
        required: string;
        line: string;
    };
};
export type DaemonState = {
    sources: {
        [repoURL: string]: SourceState;
    };
    userKeyHashes: {
        [userName: string]: string;
    };
    revocations: {
        [revocationId: string]: RevocationState;
    };
    pendingRevocations: PendingRevocation[];
    appliedKeys: string[];
    authLogOffset: number;
    authLogSignature: string;
};
export declare function getState(): DaemonState;
/** Per source progress, created on first use so a newly added source starts clean. */
export declare function sourceState(repoURL: string): SourceState;
export declare function loadState(): Promise<void>;
export declare function saveState(): Promise<void>;
