import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { normalizeKeys } from "../authorizedKeys";
import { sourceRepoPath } from "../sources";
import { MANIFEST_NAME, normalizeContent, SIGN_NAMESPACE, SIGNATURE_NAME } from "../../signedFiles/manifest";
import { verifySSHSIG } from "../../signedFiles/sshsig";
import { SIGNER_CHANGE_DELAY } from "./paths";
import { notify } from "./notify";
import { saveState, sourceState } from "./state";

// A source that has never been signed reads as this, so losing a signature counts as a change of
// signer rather than as something to wave through.
const UNSIGNED = "";
// What fixes both of the signature problems we report, so the message can say so rather than
// leaving someone to work it out.
const SIGN_COMMAND = "yarn signfiles git";

/** The ssh keys out of the signed files: the combined authorized_keys if it was signed, otherwise
    every signed top level .pub. Only ever the signed content, since that is all the map holds. */
function keysFromSignedFiles(files: Map<string, Buffer>) {
    let combined = files.get("authorized_keys");
    if (combined) {
        return normalizeKeys(combined.toString("utf8"));
    }
    let keys: string[] = [];
    for (let [filePath, contents] of files) {
        if (filePath.endsWith(".pub") && !filePath.includes("/")) {
            keys.push(...normalizeKeys(contents.toString("utf8")));
        }
    }
    return keys;
}

/** A repo that cannot be trusted, with the message ready for whoever asked. Not every caller
    treats these the same - a source keeps its last keys, a machine list is just refused - so the
    kind is carried rather than acted on here. */
export class SignedRepoError extends Error {
    constructor(public problem: string, public headline: string, public body: string) {
        super(`${headline}. ${body}`);
    }
}

/** Everything a signed checkout vouches for, in one call: who signed it, and the contents of every
    file the signature actually covers.

    UNSIGNED with no files when there is no signature at all. Throws a SignedRepoError when a
    signature is present but does not hold up, or when a file it signed for was changed or removed
    without re-signing - either way the caller keeps whatever it last accepted rather than believing
    a repo that no longer matches what was signed. A file not in the manifest is just unsigned, so
    it is left out and warned about rather than treated as tampering. */
export async function readSignedRepo(repoPath: string): Promise<{
    signer: string;
    manifestHash: string;
    signatureHash: string;
    files: Map<string, Buffer>;
}> {
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

    let stale = (detail: string) => new SignedRepoError(
        "stale",
        `KEY REPO CHANGED WITHOUT BEING SIGNED`,
        `${detail}, so the repo is being ignored and this machine keeps using what it last accepted.`
        + `\n\nTo make the change take effect, run in that repo:\n\`\`\`\n${SIGN_COMMAND}\n\`\`\``
    );

    // Every file on disk, other than git's own directory and the two signature files, which cannot
    // describe themselves.
    let listCheckoutFiles = async (prefix?: string): Promise<string[]> => {
        let found: string[] = [];
        for (let entry of await fs.readdir(path.join(repoPath, prefix || ""), { withFileTypes: true })) {
            let relativePath = prefix && `${prefix}/${entry.name}` || entry.name;
            if (entry.name === ".git") continue;
            if (!prefix && (entry.name === MANIFEST_NAME || entry.name === SIGNATURE_NAME)) continue;
            if (entry.isDirectory()) {
                found.push(...await listCheckoutFiles(relativePath));
                continue;
            }
            found.push(relativePath);
        }
        return found.sort();
    };

    let manifest = JSON.parse(manifestBytes.toString("utf8"));
    let listed = new Map<string, { size: number; sha256: string }>(
        (manifest.files || []).map((file: { path: string; size: number; sha256: string }) => [file.path, file])
    );

    let files = new Map<string, Buffer>();
    for (let filePath of await listCheckoutFiles()) {
        let expected = listed.get(filePath);
        // A file the signature never mentioned is not tampering, it is just unsigned - left out
        // rather than trusted. An extra file in a working tree is ordinary, so it is only a note.
        if (!expected) {
            console.log(`Ignoring ${path.join(repoPath, filePath)}, it is not in the signed manifest`);
            continue;
        }
        let contents = normalizeContent(await fs.readFile(path.join(repoPath, filePath)));
        let hash = crypto.createHash("sha256").update(contents).digest("hex");
        // A file the manifest DOES name, but whose content no longer matches, is a signed file
        // changed without re-signing - the repo being edited out from under its signature.
        if (contents.length !== expected.size || hash !== expected.sha256) {
            throw stale(`${path.join(repoPath, filePath)} was changed after it was signed`);
        }
        files.set(filePath, contents);
    }
    for (let filePath of listed.keys()) {
        if (!files.has(filePath)) {
            throw stale(`${path.join(repoPath, filePath)} is signed for but missing`);
        }
    }

    return { signer, manifestHash, signatureHash, files };
}

export function describeSigner(signer: string) {
    return signer === UNSIGNED && "<no public key>" || signer;
}

/** Reports a problem with a source's signature, but only when it is not the same problem we
    already reported, so a fault that persists does not repeat every check. */
async function reportProblem(config: { repoURL: string; problem: string; headline: string; body: string }) {
    let { repoURL, problem, headline, body } = config;
    let sourceStateValue = sourceState(repoURL);
    if (sourceStateValue.reportedProblem === problem) {
        return;
    }
    sourceStateValue.reportedProblem = problem;
    await saveState();
    await notify(headline, body);
}

/** The keys a source is allowed to contribute right now. A source signed by someone we have not
    accepted keeps contributing the keys we last accepted, until the delay has passed. */
export async function resolveSourceKeys(repoURL: string) {
    let sourceStateValue = sourceState(repoURL);
    let repoPath = sourceRepoPath(repoURL);

    let signer: string;
    let signedFiles: Map<string, Buffer>;
    let manifestHash: string;
    let signatureHash: string;
    try {
        let signed = await readSignedRepo(repoPath);
        signer = signed.signer;
        signedFiles = signed.files;
        manifestHash = signed.manifestHash;
        signatureHash = signed.signatureHash;
    } catch (e) {
        // The read layer already knows what is wrong and how to say it, so this only forwards it.
        // Anything that is not a signed repo problem is a real fault and is not swallowed.
        if (!(e instanceof SignedRepoError)) {
            throw e;
        }
        await reportProblem({ repoURL, problem: e.problem, headline: e.headline, body: e.body });
        return sourceStateValue.acceptedKeys;
    }
    if (sourceStateValue.reportedProblem) {
        sourceStateValue.reportedProblem = "";
        await saveState();
    }
    let checkoutKeys = keysFromSignedFiles(signedFiles);

    let accept = async () => {
        sourceStateValue.accepted = true;
        sourceStateValue.acceptedSigner = signer;
        sourceStateValue.acceptedKeys = checkoutKeys;
        sourceStateValue.acceptedManifestHash = manifestHash;
        sourceStateValue.acceptedSignatureHash = signatureHash;
        sourceStateValue.pendingSigner = UNSIGNED;
        sourceStateValue.pendingSince = 0;
        await saveState();
        return checkoutKeys;
    };

    // Nothing has ever been accepted from this source, so this is what we start trusting.
    if (!sourceStateValue.accepted) {
        console.log(`Trusting ${repoURL} as signed by ${describeSigner(signer)}`);
        return await accept();
    }

    if (signer === sourceStateValue.acceptedSigner) {
        // Back to the signer we already trust, so anything we were waiting on is moot.
        if (sourceStateValue.pendingSince) {
            console.log(`${repoURL} is signed by its accepted key again, dropping the pending change`);
        }
        return await accept();
    }

    // Going from nothing to something signed is only ever an improvement, so it does not wait.
    if (sourceStateValue.acceptedSigner === UNSIGNED) {
        await notify(`KEY REPO IS NOW SIGNED`,
            `\`${repoURL}\` was not signed at all before, so this is an improvement and its keys`
            + ` are being applied right away.`
            + `\n\nsigned by: \`${signer}\``
        );
        return await accept();
    }

    // A signer we have not accepted. Anything new restarts the wait, so publishing twice in a row
    // gains an attacker nothing. pendingSince is what marks a wait as running, because an unsigned
    // checkout is itself a signer value and cannot double as "nothing pending".
    if (!sourceStateValue.pendingSince || signer !== sourceStateValue.pendingSigner) {
        sourceStateValue.pendingSigner = signer;
        sourceStateValue.pendingSince = Date.now();
        await saveState();
        await notify(`KEY REPO SIGNED BY A DIFFERENT KEY`,
            `Somebody else is signing \`${repoURL}\` now. Its keys are NOT being applied, and this`
            + ` machine is still using the ones it already had. If nothing changes, the new signer`
            + ` is accepted in 24 hours.`
            + `\n\nIf that was not you, fix the repo before the 24 hours are up.`
            + `\n\nsigned by now: \`${describeSigner(signer)}\``
            + `\nsigned by before: \`${describeSigner(sourceStateValue.acceptedSigner)}\``
        );
        return sourceStateValue.acceptedKeys;
    }

    if (Date.now() - sourceStateValue.pendingSince < SIGNER_CHANGE_DELAY) {
        return sourceStateValue.acceptedKeys;
    }

    // Same new signer, 24 hours later, and nobody stopped it.
    console.log(`Accepting ${describeSigner(signer)} for ${repoURL} after the ${SIGNER_CHANGE_DELAY}ms wait`);
    return await accept();
}
