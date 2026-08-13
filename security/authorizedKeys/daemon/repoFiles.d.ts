/** Reading a repo, made to look like reading a directory. A caller asks for a file and gets its
    contents; keeping a checkout on disk, cloning it once and pulling it since, is this module's
    business and nobody else's.

    Nothing here ever answers "there is nothing" when the truth is "I could not look". A repo that
    cannot be reached throws, and the caller skips that source, because reading an unreachable
    revoke repo as empty would un-revoke every key in it. */
export type RepoRef = {
    repoURL: string;
    repoPath: string;
    keyPath: () => Promise<string>;
};
export declare function sourceRepo(sourceURL: string): RepoRef;
export declare function revokeRepo(sourceURL: string): RepoRef;
/** The revoke repo's key is worked out from the source's, so nothing extra had to be uploaded and
    nothing extra is stored anywhere it could be taken from. */
export declare function ensureRevokeKey(sourceURL: string): Promise<string>;
/** Brings the checkout in line with the remote. Cloned the first time, pulled after that, and the
    usual case of nothing having changed costs one ref listing and no objects. Throws if the repo
    cannot be read, so a caller cannot mistake that for an empty repo. */
export declare function syncRepoFiles(repo: RepoRef): Promise<void>;
/** One file out of the repo, or undefined if the repo does not have that file. */
export declare function readRepoFile(repo: RepoRef, filePath: string): Promise<string | undefined>;
/** The names in one of the repo's directories, or nothing if it has no such directory. */
export declare function listRepoDir(repo: RepoRef, directory: string): Promise<string[]>;
