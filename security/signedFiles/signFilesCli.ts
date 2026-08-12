import { runPromise } from "socket-function/src/runPromise";
import { spawnPromise } from "../helpers/spawn";
import { resolveKeysRepo } from "../authorizedKeys/keysRepo";
import { MANIFEST_NAME, SIGNATURE_NAME } from "./manifest";
import { DEFAULT_KEY_PATH, DEFAULT_KEY_TYPE, signRepo } from "./signFiles";

const GIT_KEYWORD = "git";
const COMMIT_MESSAGE = "deploying signed files";
const USAGE = `Usage: yarn signfiles [signing-key] [${GIT_KEYWORD}]

Signs the files of the repo in the current directory. With no key, a hardware backed
${DEFAULT_KEY_TYPE} key at ${DEFAULT_KEY_PATH} is used, and created if it does not exist.
Pass ${GIT_KEYWORD} to also commit and push the result.`;

function parseArgs(argv: string[]) {
    let pushToGit = argv.includes(GIT_KEYWORD);
    let positional = argv.filter(arg => arg !== GIT_KEYWORD);
    if (positional.length > 1) {
        throw new Error(`Expected at most a signing key, was ${positional.length} argument(s): ${positional.join(" ")}\n${USAGE}`);
    }
    return { keyPath: positional[0], pushToGit };
}

async function main() {
    let { keyPath, pushToGit } = parseArgs(process.argv.slice(2));

    // The keys repo, which is this one when it holds keys and this machine's otherwise. Signing
    // whatever repo the terminal happened to be in is how you end up signing something that is not
    // a keys repo at all.
    let { repoPath } = await resolveKeysRepo();
    console.log(`Signing ${repoPath}`);
    await signRepo({ repoPath, keyPath });

    if (!pushToGit) {
        console.log(`Commit and push ${MANIFEST_NAME} and ${SIGNATURE_NAME} for anything to see them.`);
        return;
    }
    await runPromise(`git add -A`, { cwd: repoPath });
    // Nothing staged is not worth stopping on. git commit calls that a failure, but it only means
    // the signature matches the one already committed, so there is nothing to deploy.
    let status = await spawnPromise({ command: "git", args: ["status", "--porcelain"], cwd: repoPath });
    if (!status.stdout.trim()) {
        console.log(`Nothing changed, ${MANIFEST_NAME} and ${SIGNATURE_NAME} are already committed.`);
        return;
    }
    await runPromise(`git commit -m "${COMMIT_MESSAGE}"`, { cwd: repoPath });
    await runPromise(`git push`, { cwd: repoPath });
    console.log(`Committed and pushed.`);
}

main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
