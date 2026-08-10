import fs from "fs/promises";
import path from "path";
import { STATE_PATH } from "./paths";

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

/** A key this machine has stopped accepting. Kept even when the revoke repo no longer lists it:
    the deploy key that writes revocations lives on every server, so an attacker who took one could
    otherwise delete the revocation that locked them out. */
export type RevocationState = {
    fingerprint: string;
    revocationId: string;
    // Set once an unrevoke has been seen, so the wait can be served out across restarts.
    unrevokeSeenAt: number;
    unrevokeId: string;
    unrevoked: boolean;
    // Whether we have said that this key actually left root's authorized_keys. The removal is the
    // thing worth reporting, and it is worth reporting exactly once.
    reportedRemoved: boolean;
};

export type DaemonState = {
    sources: { [repoURL: string]: SourceState };
    userKeyHashes: { [userName: string]: string };
    revocations: { [fingerprint: string]: RevocationState };
    // Where we had read up to in the auth log, so a restart does not re-report old attempts.
    authLogOffset: number;
    authLogSignature: string;
};

let state: DaemonState = {
    sources: {},
    userKeyHashes: {},
    revocations: {},
    authLogOffset: 0,
    authLogSignature: "",
};

export function getState() {
    return state;
}

/** Per source progress, created on first use so a newly added source starts clean. */
export function sourceState(repoURL: string) {
    let existing = state.sources[repoURL];
    if (existing) {
        return existing;
    }
    let created: SourceState = {
        lastSha: "",
        branch: "",
        accepted: false,
        acceptedSigner: "",
        acceptedKeys: [],
        acceptedManifestHash: "",
        acceptedSignatureHash: "",
        pendingSigner: "",
        pendingSince: 0,
        reportedProblem: "",
    };
    state.sources[repoURL] = created;
    return created;
}

export async function loadState() {
    let contents;
    try {
        contents = await fs.readFile(STATE_PATH, "utf8");
    } catch (e) {
        return;
    }
    try {
        state = Object.assign(state, JSON.parse(contents));
    } catch (e) {
        // Corrupt state only costs us one duplicate notification, so it is not worth failing over.
        console.log(`Ignoring unreadable state file ${STATE_PATH}. ${e}`);
    }
}

export async function saveState() {
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify(state, undefined, 4), { mode: 0o600 });
}
