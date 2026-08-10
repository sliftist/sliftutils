import { spawnPromise } from "./spawn";

const SSH_CONNECT_TIMEOUT = 10;
const EXISTS_MARKER = "__PORTSECURE_EXISTS__";
const MISSING_MARKER = "__PORTSECURE_MISSING__";
const MAX_ERROR_BODY_LENGTH = 500;

// /etc is root owned, so fall back to sudo whenever the SSH user is not root.
export const SUDO_PREAMBLE = `SUDO=""; if [ "$(id -u)" -ne 0 ]; then SUDO="sudo -n"; fi`;

/** The host string is handed to ssh untouched. Users, keys and ports belong in the caller's ssh
    config, so BatchMode makes a missing setup fail immediately instead of prompting. */
export async function runOverSSH(config: { host: string; script: string; input?: string; allowFailure?: boolean }) {
    let { host, script, input, allowFailure } = config;
    let result = await spawnPromise({
        command: "ssh",
        args: [
            "-o", "BatchMode=yes",
            "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
            host,
            script,
        ],
        input,
        inheritStderr: !allowFailure,
    });
    if (result.error) {
        throw new Error(`Expected ssh to run against ${host}, failed with ${result.error.message}`);
    }
    if (result.status !== 0 && !allowFailure) {
        throw new Error(
            `Expected ssh to ${host} to exit 0, was ${result.status} (see the error output above).`
            + ` Non-interactive ssh access to ${host} has to work on its own - fix it in your ssh config.`
        );
    }
    return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

/** Returns undefined when the file does not exist, so a missing file reads differently from an
    empty one. */
export async function readRemoteFile(config: { host: string; filePath: string }) {
    let { host, filePath } = config;
    let output = (await runOverSSH({
        host,
        script: `${SUDO_PREAMBLE}
if $SUDO test -f "${filePath}"; then
    echo "${EXISTS_MARKER}"
    $SUDO cat "${filePath}"
else
    echo "${MISSING_MARKER}"
fi`,
    })).stdout;
    let newlineIndex = output.indexOf("\n");
    let marker = output.slice(0, newlineIndex).trim();
    if (marker === MISSING_MARKER) {
        return undefined;
    }
    if (marker !== EXISTS_MARKER) {
        throw new Error(`Expected ${EXISTS_MARKER} or ${MISSING_MARKER} from ${host}, was ${output.slice(0, MAX_ERROR_BODY_LENGTH)}`);
    }
    return output.slice(newlineIndex + 1);
}

export async function writeRemoteFile(config: {
    host: string;
    filePath: string;
    contents: string;
    fileMode: string;
    directoryMode: string;
}) {
    let { host, filePath, contents, fileMode, directoryMode } = config;
    let directory = filePath.slice(0, filePath.lastIndexOf("/"));
    await runOverSSH({
        host,
        // Deploying from Windows must not carry CRLF onto the target, where it breaks systemd
        // units and makes private keys unreadable to ssh.
        input: contents.replace(/\r\n/g, "\n"),
        script: `${SUDO_PREAMBLE}
set -e
$SUDO mkdir -p "${directory}"
$SUDO chmod ${directoryMode} "${directory}"
$SUDO tee "${filePath}" > /dev/null
$SUDO chmod ${fileMode} "${filePath}"`,
    });
}

export async function remoteCommandExists(config: { host: string; command: string }) {
    let { host, command } = config;
    let result = await runOverSSH({
        host,
        script: `command -v "${command}" > /dev/null 2>&1 && echo yes || echo no`,
        allowFailure: true,
    });
    return result.stdout.trim() === "yes";
}
