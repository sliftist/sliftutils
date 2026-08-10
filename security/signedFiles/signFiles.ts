import fs from "fs/promises";
import os from "os";
import path from "path";
import { expandHome } from "../helpers/paths";
import { spawnPromise } from "../helpers/spawn";
import { buildManifest, formatManifest, MANIFEST_NAME, SIGNATURE_NAME, SIGN_NAMESPACE } from "./manifest";

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

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

async function run(config: { command: string; args: string[]; cwd?: string; interactive?: boolean }) {
    let { command, args, cwd, interactive } = config;
    let result = await spawnPromise({ command, args, cwd, inheritStderr: interactive });
    if (result.error) {
        throw new Error(`Expected ${command} to run, failed with ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(
            `Expected ${command} ${args.join(" ")} to exit 0, was ${result.status}. `
            + `${(result.stderr || "").slice(0, MAX_ERROR_BODY_LENGTH)}`
        );
    }
    return result;
}

/** Creating this needs the security key plugged in, and a touch, so its output goes straight to
    the terminal rather than being captured. */
async function ensureDefaultKey() {
    let keyPath = expandHome(DEFAULT_KEY_PATH);
    if (await pathExists(keyPath)) {
        return keyPath;
    }
    console.log(`No signing key at ${keyPath}, creating an ${DEFAULT_KEY_TYPE} one.`);
    console.log(`Plug your security key in - you will be asked to touch it.`);
    await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    await run({
        command: "ssh-keygen",
        args: ["-t", DEFAULT_KEY_TYPE, "-f", keyPath, "-N", "", "-C", "signfiles"],
        interactive: true,
    });
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

function parseArgs(argv: string[]) {
    let pushToGit = argv.includes(GIT_KEYWORD);
    let positional = argv.filter(arg => arg !== GIT_KEYWORD);
    if (positional.length > 1) {
        throw new Error(`Expected at most a signing key, was ${positional.length} argument(s): ${positional.join(" ")}\n${USAGE}`);
    }
    return { keyPath: positional[0], pushToGit };
}

export async function main() {
    let { keyPath, pushToGit } = parseArgs(process.argv.slice(2));

    let topLevel = await spawnPromise({ command: "git", args: ["rev-parse", "--show-toplevel"] });
    if (topLevel.status !== 0) {
        throw new Error(`Expected the current directory to be inside a git repo, it is not.\n${USAGE}`);
    }
    let repoPath = topLevel.stdout.trim();

    let signingKey = keyPath && expandHome(keyPath) || await ensureDefaultKey();
    if (!await pathExists(signingKey)) {
        throw new Error(`Expected a signing key at ${signingKey}, no such file exists`);
    }

    let manifest = await buildManifest(repoPath);
    let manifestPath = path.join(repoPath, MANIFEST_NAME);
    await fs.writeFile(manifestPath, formatManifest(manifest));
    console.log(`${MANIFEST_NAME} covers ${manifest.files.length} file(s) in ${repoPath}`);

    // Signing happens before any git work, so a failed push never costs a second touch of the key.
    await run({
        command: "ssh-keygen",
        args: ["-Y", "sign", "-f", signingKey, "-n", SIGN_NAMESPACE, manifestPath],
        interactive: true,
    });
    console.log(`Signed with ${await publicKeyOf(signingKey)}`);

    if (!pushToGit) {
        console.log(`Commit and push ${MANIFEST_NAME} and ${SIGNATURE_NAME} for anything to see them.`);
        return;
    }
    await run({ command: "git", args: ["add", "-A"], cwd: repoPath, interactive: true });
    await run({ command: "git", args: ["commit", "-m", COMMIT_MESSAGE], cwd: repoPath, interactive: true });
    await run({ command: "git", args: ["push"], cwd: repoPath, interactive: true });
    console.log(`Committed and pushed.`);
}
