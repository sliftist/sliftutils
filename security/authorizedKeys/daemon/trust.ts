import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { MANIFEST_NAME, normalizeContent, SIGN_NAMESPACE, SIGNATURE_NAME } from "../../signedFiles/manifest";
import { verifySSHSIG } from "../../signedFiles/sshsig";
import { keyFingerprint } from "../authorizedKeys";
import { revokeRepoPath } from "../revokeSource";

// A source that has never been signed reads as this, so losing a signature counts as a change of
// signer rather than as something to wave through.
export const UNSIGNED = "";
// What fixes both of the signature problems we report, so the message can say so rather than
// leaving someone to work it out.
const SIGN_COMMAND = "yarn signfiles git";
const REVOCATIONS_DIR = "revocations";
const UNREVOKES_DIR = "unrevoked";

// Every revocation this process has ever seen, keyed by revocation id. Once absorbed a revocation
// never leaves, even if its file disappears from the revoke repo - the key that writes revocations
// is on every server, so whoever stole one could otherwise erase the record that shut them out.
// Restarting the process is the way back from a revocation that should not have happened.
let absorbedRevocations = new Map<string, { identity: string; ip: string }>();
// The pairs the signed unrevokes allow, and the legacy revocation ids they name. Rebuilt on every
// read, since unrevokes are signed content and removing one must take effect.
let unrevokedPairs = new Set<string>();
let unrevokedIds = new Set<string>();

/** Whether an identity - a key fingerprint or a machine id - has a revocation nothing has undone.
    The one meaning of "frozen", used both when stripping repo content and when explaining why. */
export function isIdentityFrozen(identity: string) {
    for (let [revocationId, revocation] of absorbedRevocations) {
        if (revocation.identity !== identity) {
            continue;
        }
        if (unrevokedIds.has(revocationId) || unrevokedPairs.has(`${identity} ${revocation.ip}`)) {
            continue;
        }
        return true;
    }
    return false;
}

export function isPairRevoked(identity: string, ip: string) {
    for (let [revocationId, revocation] of absorbedRevocations) {
        if (revocation.identity === identity && revocation.ip === ip && !unrevokedIds.has(revocationId)) {
            return true;
        }
    }
    return false;
}

export function isPairUnrevoked(identity: string, ip: string) {
    return unrevokedPairs.has(`${identity} ${ip}`);
}

/** For whoever just wrote a revocation, so it holds here immediately rather than on the next
    absorb. Sticky like the rest. */
export function noteRevocation(revocationId: string, identity: string, ip: string) {
    absorbedRevocations.set(revocationId, { identity, ip });
}

/** A repo whose signature does not check out, with the message ready for whoever asked. Not every
    caller treats it the same - a source keeps its last keys, a machine list is just refused - so
    the kind is carried rather than acted on here. */
export class SignedRepoError extends Error {
    constructor(public problem: string, public headline: string, public body: string) {
        super(`${headline}. ${body}`);
    }
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
export async function readSignedRepo(config: { repoPath: string; sourceURL: string }): Promise<{
    signer: string;
    manifestHash: string;
    signatureHash: string;
    files: Map<string, Buffer>;
}> {
    let { repoPath, sourceURL } = config;
    let manifestBytes = await fs.readFile(path.join(repoPath, MANIFEST_NAME)).catch(() => undefined);
    let signatureBytes = await fs.readFile(path.join(repoPath, SIGNATURE_NAME)).catch(() => undefined);
    let manifestHash = manifestBytes && crypto.createHash("sha256").update(manifestBytes).digest("hex") || "";
    let signatureHash = signatureBytes && crypto.createHash("sha256").update(signatureBytes).digest("hex") || "";

    if (!manifestBytes && !signatureBytes) {
        console.log(`${repoPath} is not signed, ignoring all of its files`);
        return { signer: UNSIGNED, manifestHash, signatureHash, files: new Map() };
    }

    let broken = (detail: string) => new SignedRepoError(
        "corrupt",
        `KEY REPO SIGNATURE IS BROKEN`,
        `The signature on ${repoPath} does not check out, so everything in it is being ignored and`
        + ` this machine keeps using what it last accepted.\n\n${detail}`
        + `\n\nTo replace the signature, run in that repo:\n\`\`\`\n${SIGN_COMMAND}\n\`\`\``
    );
    if (!manifestBytes || !signatureBytes) {
        throw broken(`Only one of ${MANIFEST_NAME} and ${SIGNATURE_NAME} is present.`);
    }

    let signer: string;
    try {
        // The signature covers the normalised bytes, so a checkout that arrived with CRLF still
        // verifies rather than looking like tampering.
        signer = verifySSHSIG({
            signature: signatureBytes.toString("utf8"),
            message: normalizeContent(manifestBytes),
            namespace: SIGN_NAMESPACE,
        }).publicKey;
    } catch (e) {
        throw broken(`${e}`);
    }

    // The manifest is the list of files, so it is the only thing we read. Whatever else is in the
    // checkout is never opened and never mentioned - a working tree full of node_modules is not
    // something to report on, it is simply not what was signed.
    //
    // A file counts only if its contents still match what the manifest says. One that does not is
    // left out on its own: it is a file we hold no signature for, and it says nothing about the
    // files that DO match. Only the signature over the manifest can discredit the whole repo.
    let manifest = JSON.parse(manifestBytes.toString("utf8"));
    let listed = (manifest.files || []) as { path: string; size: number; sha256: string }[];

    let files = new Map<string, Buffer>();
    for (let expected of listed) {
        let contents = await fs.readFile(path.join(repoPath, expected.path)).catch(() => undefined);
        if (!contents) {
            console.log(`${path.join(repoPath, expected.path)} is in the signed manifest, but is not here`);
            continue;
        }
        contents = normalizeContent(contents);
        let hash = crypto.createHash("sha256").update(contents).digest("hex");
        if (contents.length !== expected.size || hash !== expected.sha256) {
            console.log(
                `Ignoring ${path.join(repoPath, expected.path)}, it was changed after it was signed.`
                + ` Run ${SIGN_COMMAND} in that repo to sign it as it now is.`
            );
            continue;
        }
        files.set(expected.path, contents);
    }

    // Absorb the revoke repo's files into the sticky map. Once seen a revocation never leaves it,
    // even if its file disappears - the key that writes revocations is on every server, so whoever
    // stole one could otherwise erase the record that shut them out.
    let revocationsDirectory = path.join(revokeRepoPath(sourceURL), REVOCATIONS_DIR);
    for (let name of (await fs.readdir(revocationsDirectory).catch(() => [] as string[])).sort()) {
        if (!name.endsWith(".json")) {
            continue;
        }
        try {
            let parsed = JSON.parse(await fs.readFile(path.join(revocationsDirectory, name), "utf8"));
            let identity = parsed.fingerprint || parsed.machineId;
            if (!identity) {
                continue;
            }
            let revocationId = parsed.revocationId || name.replace(/\.json$/, "");
            if (!absorbedRevocations.has(revocationId)) {
                absorbedRevocations.set(revocationId, { identity, ip: parsed.ip || parsed.attempt?.ip || "" });
            }
        } catch (e) {
            console.log(`Ignoring unreadable revocation ${path.join(revocationsDirectory, name)}. ${e}`);
        }
    }

    // Rebuild the unrevokes from the signed files just read. Unrevokes are signed content, so
    // removing one must take effect, unlike the sticky revocations.
    unrevokedPairs = new Set();
    unrevokedIds = new Set();
    for (let [filePath, contents] of files) {
        if (!filePath.startsWith(`${UNREVOKES_DIR}/`) || !filePath.endsWith(".json")) {
            continue;
        }
        try {
            let parsed = JSON.parse(contents.toString("utf8"));
            for (let allowed of parsed.allowed || []) {
                let identity = allowed.fingerprint || allowed.machineId;
                if (identity && allowed.ip) {
                    unrevokedPairs.add(`${identity} ${allowed.ip}`);
                }
            }
            for (let revocationId of parsed.revocationIds || []) {
                unrevokedIds.add(revocationId);
            }
        } catch (e) {
            console.log(`Ignoring unreadable unrevoke ${filePath}. ${e}`);
        }
    }

    // Drop everything frozen: revoked keys out of authorized_keys and top level .pub files, and
    // frozen machines' files out of machines/. What comes back is what this machine actually
    // trusts, so no caller can read the list and forget the revocations.
    for (let [filePath, contents] of [...files]) {
        if (filePath === "authorized_keys" || (filePath.endsWith(".pub") && !filePath.includes("/"))) {
            let lines = contents.toString("utf8").split("\n");
            let kept = lines.filter(line => {
                let fingerprint = keyFingerprint(line);
                if (fingerprint && isIdentityFrozen(fingerprint)) {
                    console.log(`Dropping revoked key ${fingerprint} from ${path.join(repoPath, filePath)}`);
                    return false;
                }
                return true;
            });
            if (kept.length !== lines.length) {
                files.set(filePath, Buffer.from(kept.join("\n")));
            }
        }
        if (filePath.startsWith("machines/") && filePath.endsWith(".json")) {
            let machineId = filePath.slice("machines/".length, -".json".length);
            if (isIdentityFrozen(machineId)) {
                console.log(`Dropping frozen machine ${machineId} from ${path.join(repoPath, filePath)}`);
                files.delete(filePath);
            }
        }
    }

    return { signer, manifestHash, signatureHash, files };
}
