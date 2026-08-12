import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { spawnPromise } from "../../helpers/spawn";
import { normalizeKeys } from "../authorizedKeys";
import { sourceRepoPath } from "../sources";
import { MANIFEST_NAME, normalizeContent, SIGN_NAMESPACE, SIGNATURE_NAME } from "../../signedFiles/manifest";
import { MAX_ERROR_BODY_LENGTH, SIGNER_CHANGE_DELAY } from "./paths";
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

function readSSHString(buffer: Buffer, offset: number) {
    let length = buffer.readUInt32BE(offset);
    return buffer.subarray(offset + 4, offset + 4 + length);
}

/** The signature carries the public key that made it, so the key itself can be reported rather
    than only a fingerprint. Returns it in the usual "type base64" form. */
export function publicKeyFromSignature(signatureText: string) {
    let body = signatureText.split("\n").filter(line => line && !line.startsWith("-----")).join("");
    let blob = Buffer.from(body, "base64");
    if (blob.subarray(0, 6).toString() !== "SSHSIG") {
        throw new Error(`Expected an SSHSIG signature, started with ${blob.subarray(0, 6).toString()}`);
    }
    // The magic, then a uint32 version, then the public key.
    let publicKey = readSSHString(blob, 6 + 4);
    let keyType = readSSHString(publicKey, 0).toString();
    let fingerprint = "SHA256:" + crypto.createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "");
    return { publicKey: `${keyType} ${publicKey.toString("base64")}`, fingerprint };
}

/** Reads one checkout's keys. Prefers a top level authorized_keys file and otherwise concatenates
    every .pub at the top level. */
export async function readCheckoutKeys(repoPath: string) {
    let combinedPath = path.join(repoPath, "authorized_keys");
    if (await pathExists(combinedPath)) {
        return normalizeKeys(await fs.readFile(combinedPath, "utf8"));
    }
    let pubFiles = (await fs.readdir(repoPath)).filter(name => name.endsWith(".pub")).sort();
    if (!pubFiles.length) {
        throw new Error(`Expected authorized_keys or at least one .pub file in ${repoPath}, found neither`);
    }
    let keys: string[] = [];
    for (let name of pubFiles) {
        keys.push(...normalizeKeys(await fs.readFile(path.join(repoPath, name), "utf8")));
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

/** The signature only covers the manifest, so the manifest has to be checked against what is
    actually on disk. Both directions matter: a missing file changes what the keys mean, and an
    extra unlisted file could add keys nobody signed for. */
async function verifyManifestMatchesFiles(repoPath: string) {
    let manifest = JSON.parse(await fs.readFile(path.join(repoPath, MANIFEST_NAME), "utf8"));
    let listed = new Map<string, { path: string; size: number; sha256: string }>(
        (manifest.files || []).map((file: { path: string }) => [file.path, file])
    );
    let actual = await listCheckoutFiles(repoPath);

    let missing = [...listed.keys()].filter(filePath => !actual.includes(filePath));
    if (missing.length) {
        throw new Error(
            `Expected the signed files to be present, ${missing.length} missing, first `
            + `${path.join(repoPath, missing[0])}`
        );
    }
    let extra = actual.filter(filePath => !listed.has(filePath));
    if (extra.length) {
        throw new Error(
            `Expected only signed files to be present, ${extra.length} extra, first `
            + `${path.join(repoPath, extra[0])}`
        );
    }
    for (let filePath of actual) {
        let expected = listed.get(filePath);
        if (!expected) {
            continue;
        }
        let contents = normalizeContent(await fs.readFile(path.join(repoPath, filePath)));
        if (contents.length !== expected.size) {
            throw new Error(`Expected ${path.join(repoPath, filePath)} to be ${expected.size} bytes, was ${contents.length}`);
        }
        let hash = crypto.createHash("sha256").update(contents).digest("hex");
        if (hash !== expected.sha256) {
            throw new Error(`Expected ${path.join(repoPath, filePath)} to hash to ${expected.sha256}, was ${hash}`);
        }
    }
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
    if (!files.manifest || !files.signature) {
        throw new Error(`Expected both ${MANIFEST_NAME} and ${SIGNATURE_NAME}, only one is present`);
    }
    let result = await spawnPromise({
        command: "ssh-keygen",
        args: ["-Y", "check-novalidate", "-n", SIGN_NAMESPACE, "-s", path.join(repoPath, SIGNATURE_NAME)],
        // The signature covers the normalised bytes, so a checkout that arrived with CRLF still
        // verifies rather than looking like tampering.
        input: normalizeContent(files.manifest).toString("utf8"),
    });
    if (result.status !== 0) {
        throw new Error(
            `the signature over ${MANIFEST_NAME} does not verify: `
            + `${(result.stdout + result.stderr).trim().slice(0, MAX_ERROR_BODY_LENGTH)}`
        );
    }
    let reported = `${result.stdout} ${result.stderr}`.match(/(SHA256:[A-Za-z0-9+/=]+)/);
    if (!reported) {
        throw new Error(`ssh-keygen reported no signer fingerprint, said ${result.stdout.slice(0, MAX_ERROR_BODY_LENGTH)}`);
    }
    let { publicKey, fingerprint } = publicKeyFromSignature(files.signature.toString("utf8"));
    // The key we read out of the signature has to be the one ssh-keygen just checked against,
    // otherwise we would be reporting an identity that did not sign anything.
    if (fingerprint !== reported[1]) {
        throw new Error(`the signing key reads as ${fingerprint} but ssh-keygen verified ${reported[1]}`);
    }
    await verifyManifestMatchesFiles(repoPath);
    return publicKey;
}

/** Proves a checkout on disk was signed, and that the files in it are the ones that were signed.
    Returns the signer, and throws if anything about that does not hold.

    Anything reading a repo for something other than ssh keys goes through this first: the whole
    checkout is covered by one manifest, so a machine list is exactly as trustworthy as the keys
    beside it, and neither is worth reading unsigned. */
export async function verifyCheckout(repoPath: string) {
    return await verifyCheckoutSigner({ repoPath, files: await readSignatureFiles(repoPath) });
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
    let files = await readSignatureFiles(repoPath);

    let signer: string;
    try {
        signer = await verifyCheckoutSigner({ repoPath, files });
    } catch (e) {
        // Nothing here is trustworthy, so nothing here is used. Which of the two problems it is
        // depends on whether the signature is simply the one we already accepted.
        let unchanged = files.manifestHash === sourceStateValue.acceptedManifestHash
            && files.signatureHash === sourceStateValue.acceptedSignatureHash;
        if (unchanged) {
            await reportProblem({
                repoURL,
                problem: "stale",
                headline: `KEY REPO CHANGED WITHOUT BEING SIGNED`,
                body: `\`${repoURL}\` changed, but nobody signed the change, so it is being ignored`
                    + ` and this machine is still using the keys signed by`
                    + ` \`${describeSigner(sourceStateValue.acceptedSigner)}\`.`
                    + `\n\nTo make the change take effect, run this in that repo:`
                    + `\n\`\`\`\n${SIGN_COMMAND}\n\`\`\``,
            });
        } else {
            await reportProblem({
                repoURL,
                problem: "corrupt",
                headline: `KEY REPO SIGNATURE IS BROKEN`,
                body: `The signature on \`${repoURL}\` does not check out, so everything in it is`
                    + ` being ignored and this machine is still using the keys signed by`
                    + ` \`${describeSigner(sourceStateValue.acceptedSigner)}\`.`
                    + `\n\n${e}`
                    + `\n\nTo replace the signature, run this in that repo:`
                    + `\n\`\`\`\n${SIGN_COMMAND}\n\`\`\``,
            });
        }
        return sourceStateValue.acceptedKeys;
    }
    if (sourceStateValue.reportedProblem) {
        sourceStateValue.reportedProblem = "";
        await saveState();
    }
    let checkoutKeys = await readCheckoutKeys(repoPath);

    let accept = async () => {
        sourceStateValue.accepted = true;
        sourceStateValue.acceptedSigner = signer;
        sourceStateValue.acceptedKeys = checkoutKeys;
        sourceStateValue.acceptedManifestHash = files.manifestHash;
        sourceStateValue.acceptedSignatureHash = files.signatureHash;
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
