export declare const REVOKE_KEY_LABEL = "revokegithubkey";
export declare function revokeRepoURL(sourceURL: string): string;
export declare function revokeKeyPath(sourceURL: string): string;
export declare function legacyRevokeKeyPath(sourceURL: string): string;
/** Wherever this source's revoke key already is, or nothing if it has not been derived yet. */
export declare function findRevokeKey(sourceURL: string): Promise<string>;
export declare function revokeRepoPath(sourceURL: string): string;
/** The revoke repo's key, worked out from the source repo's key. Anything holding the source key
    can produce it, so it never has to be stored anywhere separately or handed around. */
export declare function deriveRevokeKey(sourcePrivateKey: string): {
    publicKey: string;
    privateKeyFile: string;
};
