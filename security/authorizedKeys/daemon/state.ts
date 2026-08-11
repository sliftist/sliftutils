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

/** A refusal we saw but could not write down yet. Held until it is recorded, because the log is
    read once and moves on: losing one of these to a repo that happened to be unreachable would
    leave a key that was misused accepted forever. */
export type PendingRevocation = {
    fingerprint: string;
    keyLine: string;
    sourceURL: string;
    attempt: { ip: string; user: string; port: string; required: string; line: string };
};

export type DaemonState = {
    sources: { [repoURL: string]: SourceState };
    userKeyHashes: { [userName: string]: string };
    // Held in memory only, never written to disk. Deleting a revocation from the revoke repo does
    // not bring a key back, because this machine still remembers it - the key that writes
    // revocations is on every server, so whoever stole one could otherwise erase the record that
    // shut them out. Restarting the daemon does clear it, which is the way back from a revocation
    // that should not have happened.
    revocations: { [fingerprint: string]: RevocationState };
    pendingRevocations: PendingRevocation[];
    // The keys we last wrote out. What tells a change we made apart from one somebody else made:
    // if this still matches what we want, and the file does not, the file was edited behind us.
    appliedKeys: string[];
    // Where we had read up to in the auth log, so a restart does not re-report old attempts.
    authLogOffset: number;
    authLogSignature: string;
};

let state: DaemonState = {
    sources: {},
    userKeyHashes: {},
    revocations: {},
    pendingRevocations: [],
    appliedKeys: [],
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
        let loaded = JSON.parse(contents);
        // Revocations are held in memory only, so whatever an older version left on disk is not
        // read back in. Starting the daemon is what forgets them.
        delete loaded.revocations;
        state = Object.assign(state, loaded);
    } catch (e) {
        // Corrupt state only costs us one duplicate notification, so it is not worth failing over.
        console.log(`Ignoring unreadable state file ${STATE_PATH}. ${e}`);
    }
}

export async function saveState() {
    let { revocations, ...persisted } = state;
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify(persisted, undefined, 4), { mode: 0o600 });
}
