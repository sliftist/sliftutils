/// <reference types="node" />
/// <reference types="node" />
export declare const MANIFEST_NAME = "signedfiles.json";
export declare const SIGNATURE_NAME = "signedfiles.json.sig";
export declare const SIGN_NAMESPACE = "signfiles";
export declare const MANIFEST_VERSION = 1;
export type Manifest = {
    version: number;
    files: {
        path: string;
        size: number;
        sha256: string;
    }[];
};
/** Everything in the repo that is not ignored: what is in the index, plus what is not staged yet.
    Git is asked because git is what knows how to apply the ignore rules.

    What comes back is a hint that a file might be there, not that it is. A file deleted from the
    working tree stays in the index until that deletion is staged, so git names it and there is
    nothing to read, which is why each one is checked before it goes in.

    The manifest and its signature are left out, since they cannot describe themselves. */
export declare function listRepoFiles(repoPath: string): Promise<string[]>;
/** A Windows checkout turns LF into CRLF, so the same commit hashes differently there than it
    does on the machine that pulls it. Normalising first makes the digest describe the content
    rather than whichever checkout produced it. latin1 round trips every byte, so this is safe on
    files that are not text. */
export declare function normalizeContent(contents: Buffer): Buffer;
/** The size and hash of a file's normalised content. The size is the normalised one on purpose,
    so it agrees with the hash rather than with whatever the local checkout happens to hold. */
export declare function digestFile(filePath: string): Promise<{
    size: number;
    sha256: string;
}>;
export declare function buildManifest(repoPath: string): Promise<{
    version: number;
    files: {
        path: string;
        size: number;
        sha256: string;
    }[];
}>;
/** Sorted keys and a trailing newline, so the same tree always produces the same bytes to sign. */
export declare function formatManifest(manifest: Manifest): string;
