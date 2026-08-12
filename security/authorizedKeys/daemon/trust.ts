import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { MANIFEST_NAME, normalizeContent, SIGN_NAMESPACE, SIGNATURE_NAME } from "../../signedFiles/manifest";
import { verifySSHSIG } from "../../signedFiles/sshsig";

// A source that has never been signed reads as this, so losing a signature counts as a change of
// signer rather than as something to wave through.
export const UNSIGNED = "";
// What fixes both of the signature problems we report, so the message can say so rather than
// leaving someone to work it out.
const SIGN_COMMAND = "yarn signfiles git";

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
