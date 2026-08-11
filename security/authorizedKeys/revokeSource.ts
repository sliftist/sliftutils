import { deriveEd25519Key } from "../keys/deriveKey";
import { formatOpenSSHPrivateKey, parseOpenSSHPrivateKey } from "../keys/sshKeyFile";
import path from "path";
import { findKey, keysDir, LEGACY_REPO_KEYS_DIR, REPOS_DIR, sourceName } from "./sources";

// A source's revocations live in a repo beside it. Derived rather than configured, so adding a
// source brings its revoke repo with it and there is nothing extra to pass on the command line.
const REVOKED_SUFFIX = "_revoked";
// GitHub will not take the same public key as a deploy key on two repos, so the revoke repo is
// reached with a key derived from the source's, under this label.
export const REVOKE_KEY_LABEL = "revokegithubkey";

export function revokeRepoURL(sourceURL: string) {
    let withoutGit = sourceURL.replace(/\.git$/, "");
    return `${withoutGit}${REVOKED_SUFFIX}.git`;
}

export function revokeKeyPath(sourceURL: string) {
    return path.join(keysDir(), `${sourceName(sourceURL)}${REVOKED_SUFFIX}`);
}

export function legacyRevokeKeyPath(sourceURL: string) {
    return `${LEGACY_REPO_KEYS_DIR}/${sourceName(sourceURL)}${REVOKED_SUFFIX}`;
}

/** Wherever this source's revoke key already is, or nothing if it has not been derived yet. */
export async function findRevokeKey(sourceURL: string) {
    return await findKey({ current: revokeKeyPath(sourceURL), legacy: legacyRevokeKeyPath(sourceURL) });
}

export function revokeRepoPath(sourceURL: string) {
    return `${REPOS_DIR}/${sourceName(sourceURL)}${REVOKED_SUFFIX}`;
}

/** The revoke repo's key, worked out from the source repo's key. Anything holding the source key
    can produce it, so it never has to be stored anywhere separately or handed around. */
export function deriveRevokeKey(sourcePrivateKey: string) {
    let source = parseOpenSSHPrivateKey(sourcePrivateKey);
    let derived = deriveEd25519Key({ seed: source.seed, label: REVOKE_KEY_LABEL });
    return {
        publicKey: `ssh-ed25519 ${Buffer.concat([
            Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"),
            Buffer.from([0, 0, 0, 32]), derived.publicKey,
        ]).toString("base64")}`,
        privateKeyFile: formatOpenSSHPrivateKey({
            seed: derived.seed,
            comment: `${source.comment || "portsecure"} ${REVOKE_KEY_LABEL}`,
        }),
    };
}
