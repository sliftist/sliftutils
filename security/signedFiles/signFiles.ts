import fs from "fs/promises";
import os from "os";
import path from "path";
import { runPromise } from "socket-function/src/runPromise";
import { expandHome } from "../helpers/paths";
import { spawnPromise } from "../helpers/spawn";
import { buildManifest, formatManifest, MANIFEST_NAME, SIGNATURE_NAME, SIGN_NAMESPACE } from "./manifest";
import { revokedKeysInRepo } from "../authorizedKeys/unrevoke";
import { findKeyProblems, normalizeKeys } from "../authorizedKeys/authorizedKeys";

// A hardware backed key is the entire point. A key sitting on disk is compromised the moment the
// machine is, and then the signature proves nothing, so this is what we make when asked to make one.
const DEFAULT_KEY_TYPE = "ed25519-sk";
const DEFAULT_KEY_PATH = "~/.ssh/signfiles_ed25519_sk";
const GIT_KEYWORD = "git";
const COMMIT_MESSAGE = "deploying signed files";
const MAX_ERROR_BODY_LENGTH = 500;
const USAGE = `Usage: yarn signfiles [signing-key] [${GIT_KEYWORD}]

Signs the files of the repo in the current directory. With no key, a hardware backed
${DEFAULT_KEY_TYPE} key at ${DEFAULT_KEY_PATH} is used, and created if it does not exist.
Pass ${GIT_KEYWORD} to also commit and push the result.`;

/** runPromise takes a command line rather than an argument list, so anything holding a path has to
    survive the shell. Double quotes work on both cmd and posix shells. */
function quote(value: string) {
    return `"${value}"`;
}

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

/** Creating this needs the security key plugged in, and a touch. */
async function ensureDefaultKey() {
    let keyPath = expandHome(DEFAULT_KEY_PATH);
    if (await pathExists(keyPath)) {
        return keyPath;
    }
    console.log(`No signing key at ${keyPath}, creating an ${DEFAULT_KEY_TYPE} one.`);
    console.log(`Plug your security key in - you will be asked to touch it.`);
    await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    await runPromise(`ssh-keygen -t ${DEFAULT_KEY_TYPE} -f ${quote(keyPath)} -N "" -C signfiles`);
    return keyPath;
}

/** The public key in the form the daemon reports it, so what is printed here can be compared
    against what arrives on Discord. */
async function publicKeyOf(keyPath: string) {
    let contents = await fs.readFile(`${keyPath}.pub`, "utf8");
    let [keyType, keyBody] = contents.trim().split(/\s+/);
    if (!keyType || !keyBody) {
        throw new Error(`Expected a public key in ${keyPath}.pub, was ${contents.slice(0, MAX_ERROR_BODY_LENGTH)}`);
    }
    return `${keyType} ${keyBody}`;
}

/** A keys repo has rules the rest of this cannot enforce afterwards, so they are enforced before it
    is signed. Signing anything that is not a keys repo is none of this function's business. */
async function refuseUnusableKeys(repoPath: string) {
    let authorizedPath = path.join(repoPath, "authorized_keys");
    if (!await pathExists(authorizedPath)) {
        return;
    }
    let problems = findKeyProblems(normalizeKeys(await fs.readFile(authorizedPath, "utf8")));
    if (!problems.length) {
        return;
    }
    throw new Error(
        `Expected every key in ${authorizedPath} to be restricted and to belong to one person,`
        + ` found ${problems.length} problem(s):\n`
        + problems.map(problem => `  - ${problem}`).join("\n")
        + `\n\nEvery key needs a from= naming the addresses it may be used from, and no two keys may`
        + `\nname the same ones. Revoking a key that shares its addresses with another leaves that`
        + `\nother key working, which defeats the point of revoking it.`
    );
}

/** Signing a keys repo that still holds a revoked key would publish it back to every machine that
    took it out. Only applies to a repo that holds keys and has a revoke repo to check - signing
    anything else is none of this function's business. */
async function refuseRevokedKeys(repoPath: string) {
    if (!await pathExists(path.join(repoPath, "authorized_keys"))) {
        return;
    }
    // Read for its value, so stdout has to be on its own. runPromise joins it with stderr.
    let origin = await spawnPromise({ command: "git", args: ["remote", "get-url", "origin"], cwd: repoPath });
    let originURL = origin.stdout.trim();
    if (origin.status !== 0 || !originURL) {
        return;
    }
    let revoked;
    try {
        revoked = await revokedKeysInRepo({ repoPath, sourceURL: originURL });
    } catch (e) {
        // No revoke repo, or no access to it. Nothing has been revoked that we can see.
        return;
    }
    if (!revoked.length) {
        return;
    }
    throw new Error(
        `Expected ${repoPath} to hold no revoked keys, it holds ${revoked.length}:\n`
        + revoked.map(entry => `  ${entry.revocation.fingerprint} revoked by ${entry.revocation.revokedBy || "?"}`
            + ` after use from ${entry.revocation.attempt?.ip || "?"}`).join("\n")
        + `\nDelete them from authorized_keys, or run "yarn unrevoke" here to allow them again.`
    );
}

function parseArgs(argv: string[]) {
    let pushToGit = argv.includes(GIT_KEYWORD);
    let positional = argv.filter(arg => arg !== GIT_KEYWORD);
    if (positional.length > 1) {
        throw new Error(`Expected at most a signing key, was ${positional.length} argument(s): ${positional.join(" ")}\n${USAGE}`);
    }
    return { keyPath: positional[0], pushToGit };
}

/** Writes the manifest and its signature into a repo. Separate from the command so anything that
    changes a keys repo can leave it signed, rather than telling someone to go and do it. */
export async function signRepo(config: { repoPath: string; keyPath?: string }) {
    let { repoPath } = config;
    let signingKey = config.keyPath && expandHome(config.keyPath) || await ensureDefaultKey();
    if (!await pathExists(signingKey)) {
        throw new Error(`Expected a signing key at ${signingKey}, no such file exists`);
    }

    await refuseUnusableKeys(repoPath);
    await refuseRevokedKeys(repoPath);

    let manifest = await buildManifest(repoPath);
    console.log(`${MANIFEST_NAME} covers ${manifest.files.length} file(s) in ${repoPath}`);

    // The manifest is built and signed away from the repo, and only moved in once both exist.
    // Landing a new manifest next to an old signature produces a pair that can never verify, and
    // the daemon reading it can only treat that as tampering.
    let stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "signfiles-"));
    let stagedManifest = path.join(stagingDirectory, MANIFEST_NAME);
    let stagedSignature = `${stagedManifest}.sig`;
    await fs.writeFile(stagedManifest, formatManifest(manifest));

    // Signing happens before any git work, so a failed push never costs a second touch of the key.
    await runPromise(`ssh-keygen -Y sign -f ${quote(signingKey)} -n ${SIGN_NAMESPACE} ${quote(stagedManifest)}`);
    // Checked here rather than left for a machine that has already pulled it to discover.
    await runPromise(
        `ssh-keygen -Y check-novalidate -n ${SIGN_NAMESPACE} -s ${quote(stagedSignature)} < ${quote(stagedManifest)}`
    );
    await fs.copyFile(stagedManifest, path.join(repoPath, MANIFEST_NAME));
    await fs.copyFile(stagedSignature, path.join(repoPath, SIGNATURE_NAME));
    await fs.rm(stagingDirectory, { recursive: true, force: true });
    console.log(`Signed with ${await publicKeyOf(signingKey)}`);
}

export async function main() {
    let { keyPath, pushToGit } = parseArgs(process.argv.slice(2));

    // Read for its value, so stdout has to be on its own. runPromise joins it with stderr, and a
    // git warning glued to the front of this becomes a directory that does not exist.
    let topLevel = await spawnPromise({ command: "git", args: ["rev-parse", "--show-toplevel"] });
    let repoPath = topLevel.stdout.trim();
    if (topLevel.status !== 0 || !repoPath) {
        throw new Error(
            `Expected the current directory to be inside a git repo, it is not.\n`
            + `${(topLevel.stdout + topLevel.stderr).trim()}\n${USAGE}`
        );
    }
    await signRepo({ repoPath, keyPath });

    if (!pushToGit) {
        console.log(`Commit and push ${MANIFEST_NAME} and ${SIGNATURE_NAME} for anything to see them.`);
        return;
    }
    await runPromise(`git add -A`, { cwd: repoPath });
    // Nothing staged is not worth stopping on. git commit calls that a failure, but it only means
    // the signature matches the one already committed, so there is nothing to deploy.
    let status = await spawnPromise({ command: "git", args: ["status", "--porcelain"], cwd: repoPath });
    let staged = status.stdout;
    if (!staged.trim()) {
        console.log(`Nothing changed, ${MANIFEST_NAME} and ${SIGNATURE_NAME} are already committed.`);
        return;
    }
    await runPromise(`git commit -m ${quote(COMMIT_MESSAGE)}`, { cwd: repoPath });
    await runPromise(`git push`, { cwd: repoPath });
    console.log(`Committed and pushed.`);
}
