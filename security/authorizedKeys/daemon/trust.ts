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

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}


/** Reads one checkout's keys. Prefers a top level authorized_keys file and otherwise concatenates
    every .pub at the top level. */
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

/** Every file in a checkout, other than git's own directory and the signature files, which cannot
    describe themselves. */
async function listCheckoutFiles(repoPath: string, prefix?: string): Promise<string[]> {
    let files: string[] = [];
    for (let entry of await fs.readdir(path.join(repoPath, prefix || ""), { withFileTypes: true })) {
        let relativePath = prefix && `${prefix}/${entry.name}` || entry.name;
        if (entry.name === ".git") {
            continue;
        }
        if (!prefix && (entry.name === MANIFEST_NAME || entry.name === SIGNATURE_NAME)) {
            continue;
        }
        if (entry.isDirectory()) {
            files.push(...await listCheckoutFiles(repoPath, relativePath));
            continue;
        }
        files.push(relativePath);
    }
    return files.sort();
}

/** The files the manifest actually vouches for: listed in it, present on disk, and hashing to what
    it says. Anything else on disk is not signed, so it is left out rather than trusted - an extra
    file could add keys nobody signed for. Every exclusion is warned about, so a file that should
    have been signed and was not is noticed rather than silently dropped.

    The manifest itself is only worth reading once its signature has been checked, so this is only
    ever reached through readSignedRepo. */
function collectSignedFiles(repoPath: string, manifestBytes: Buffer) {
    let manifest = JSON.parse(manifestBytes.toString("utf8"));
    let listed = new Map<string, { path: string; size: number; sha256: string }>(
        (manifest.files || []).map((file: { path: string }) => [file.path, file])
    );
    return { listed };
}

/** A repo that cannot be trusted, with the message ready for whoever asked. Not every caller
    treats these the same - a source keeps its last keys, a machine list is just refused - so the
    kind is carried rather than acted on here. */
export class SignedRepoError extends Error {
    constructor(public problem: string, public headline: string, public body: string) {
        super(`${headline}. ${body}`);
    }
}

async function readSignedContent(repoPath: string, listed: Map<string, { size: number; sha256: string }>) {
    let files = new Map<string, Buffer>();
    let actual = await listCheckoutFiles(repoPath);
    for (let filePath of actual) {
        let expected = listed.get(filePath);
        // A file the signature never mentioned is not tampering, it is just unsigned. It is left
        // out rather than trusted, and nobody has to be told - an extra file in a working tree is
        // ordinary.
        if (!expected) {
            console.log(`Ignoring ${path.join(repoPath, filePath)}, it is not in the signed manifest`);
            continue;
        }
        let contents = normalizeContent(await fs.readFile(path.join(repoPath, filePath)));
        let hash = crypto.createHash("sha256").update(contents).digest("hex");
        if (contents.length !== expected.size || hash !== expected.sha256) {
            // A file the manifest DOES name, but whose content no longer matches, is a signed file
            // that was changed without re-signing. That is the whole repo being edited out from
            // under its signature, so it is a problem, not something to quietly drop.
            throw new SignedRepoError(
                "stale",
                `KEY REPO CHANGED WITHOUT BEING SIGNED`,
                `${path.join(repoPath, filePath)} was changed after it was signed, so the repo is`
                + ` being ignored and this machine keeps using what it last accepted.`
                + `\n\nTo make the change take effect, run in that repo:\n\`\`\`\n${SIGN_COMMAND}\n\`\`\``
            );
        }
        files.set(filePath, contents);
    }
    for (let filePath of listed.keys()) {
        if (!files.has(filePath)) {
            throw new SignedRepoError(
                "stale",
                `KEY REPO CHANGED WITHOUT BEING SIGNED`,
                `${path.join(repoPath, filePath)} is signed for but missing, so the repo is being`
                + ` ignored and this machine keeps using what it last accepted.`
                + `\n\nTo make the change take effect, run in that repo:\n\`\`\`\n${SIGN_COMMAND}\n\`\`\``
            );
        }
    }
    return files;
}

/** The manifest and signature as they stand, whether or not they are any good. The hashes are
    what tell a signature that was never updated apart from one that is broken. */
async function readSignatureFiles(repoPath: string) {
    let manifestPath = path.join(repoPath, MANIFEST_NAME);
    let signaturePath = path.join(repoPath, SIGNATURE_NAME);
    let manifest = await pathExists(manifestPath) && await fs.readFile(manifestPath) || undefined;
    let signature = await pathExists(signaturePath) && await fs.readFile(signaturePath) || undefined;
    return {
        manifest,
        signature,
        manifestHash: manifest && crypto.createHash("sha256").update(manifest).digest("hex") || "",
        signatureHash: signature && crypto.createHash("sha256").update(signature).digest("hex") || "",
    };
}

/** Who signed this checkout. Returns UNSIGNED when there is no signature at all, and throws when
    there is one that does not hold up - an unverifiable signature is never treated as an identity,
    so it can never become something we accept. */
async function verifyCheckoutSigner(config: {
    repoPath: string;
    files: { manifest?: Buffer; signature?: Buffer };
}) {
    let { repoPath, files } = config;
    if (!files.manifest && !files.signature) {
        return UNSIGNED;
    }
    let broken = (detail: string) => new SignedRepoError(
        "corrupt",
        `KEY REPO SIGNATURE IS BROKEN`,
        `The signature on ${repoPath} does not check out, so everything in it is being ignored and`
        + ` this machine keeps using what it last accepted.\n\n${detail}`
        + `\n\nTo replace the signature, run in that repo:\n\`\`\`\n${SIGN_COMMAND}\n\`\`\``
    );
    if (!files.manifest || !files.signature) {
        throw broken(`Only one of ${MANIFEST_NAME} and ${SIGNATURE_NAME} is present.`);
    }
    try {
        // The signature covers the normalised bytes, so a checkout that arrived with CRLF still
        // verifies rather than looking like tampering.
        let { publicKey } = verifySSHSIG({
            signature: files.signature.toString("utf8"),
            message: normalizeContent(files.manifest),
            namespace: SIGN_NAMESPACE,
        });
        return publicKey;
    } catch (e) {
        throw broken(`${e}`);
    }
}

/** Everything a signed checkout vouches for, in one call: who signed it, and the contents of every
    file the signature actually covers. Files on disk that are not signed are left out (and warned
    about), so a caller only ever sees what was signed.

    UNSIGNED with no files when there is no signature at all. Throws only when a signature is
    present but does not hold up - that is tampering, not an absence, and the caller keeps whatever
    it last accepted rather than believing it. */
export async function readSignedRepo(repoPath: string): Promise<{
    signer: string;
    manifestHash: string;
    signatureHash: string;
    files: Map<string, Buffer>;
}> {
    let sig = await readSignatureFiles(repoPath);
    let signer = await verifyCheckoutSigner({ repoPath, files: sig });
    let files = new Map<string, Buffer>();
    if (signer !== UNSIGNED && sig.manifest) {
        let { listed } = collectSignedFiles(repoPath, sig.manifest);
        files = await readSignedContent(repoPath, listed);
    } else {
        console.log(`${repoPath} is not signed, ignoring all of its files`);
    }
    return { signer, manifestHash: sig.manifestHash, signatureHash: sig.signatureHash, files };
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
