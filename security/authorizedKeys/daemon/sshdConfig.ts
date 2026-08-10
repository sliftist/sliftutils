import fs from "fs/promises";
import { spawnPromise } from "../../helpers/spawn";
import { MAX_ERROR_BODY_LENGTH, SSHD_CONFIG_PATH, SSHD_DROPIN_DIR, SSHD_DROPIN_PATH } from "./paths";

// VERBOSE is what makes sshd name the key a refused attempt used, which is the whole basis for
// revoking it. Without it the log says an attempt was refused but not by whom.
const SSHD_DROPIN_CONTENTS = `# Managed by portsecure. Manual changes are reverted and reported.
# Keys come from the portsecure repo, so no other authentication method may be used.
PasswordAuthentication no
PermitEmptyPasswords no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
LogLevel VERBOSE
`;

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

async function sshdConfigIncludesDropinDir() {
    let contents = await fs.readFile(SSHD_CONFIG_PATH, "utf8");
    return contents.split("\n").some(line => {
        let trimmed = line.trim();
        return trimmed.startsWith("Include") && trimmed.includes("sshd_config.d");
    });
}

async function restartSSHD() {
    for (let unit of ["ssh", "sshd"]) {
        let result = await spawnPromise({ command: "systemctl", args: ["reload-or-restart", unit] });
        if (result.status === 0) {
            return unit;
        }
    }
    throw new Error(`Expected to reload ssh or sshd, neither unit could be reloaded`);
}

/** Turns off every non key based way in. Validates before reloading, because a bad sshd config
    that gets applied is exactly how a machine becomes unreachable. */
export async function enforceSSHDConfig() {
    let existing = "";
    if (await pathExists(SSHD_DROPIN_PATH)) {
        existing = await fs.readFile(SSHD_DROPIN_PATH, "utf8");
    }
    let includeMissing = !await sshdConfigIncludesDropinDir();
    if (existing === SSHD_DROPIN_CONTENTS && !includeMissing) {
        return;
    }

    let originalConfig = await fs.readFile(SSHD_CONFIG_PATH, "utf8");
    await fs.mkdir(SSHD_DROPIN_DIR, { recursive: true });
    await fs.writeFile(SSHD_DROPIN_PATH, SSHD_DROPIN_CONTENTS, { mode: 0o644 });
    if (includeMissing) {
        // sshd takes the first value it sees for most keywords, so the include has to come before
        // any setting it is meant to override.
        await fs.writeFile(SSHD_CONFIG_PATH, `Include ${SSHD_DROPIN_DIR}/*.conf\n${originalConfig}`);
    }

    let validation = await spawnPromise({ command: "sshd", args: ["-t"] });
    if (validation.error) {
        validation = await spawnPromise({ command: "/usr/sbin/sshd", args: ["-t"] });
    }
    if (validation.status !== 0) {
        // Roll back rather than leave a config that sshd would refuse on its next start.
        await fs.rm(SSHD_DROPIN_PATH, { force: true });
        if (includeMissing) {
            await fs.writeFile(SSHD_CONFIG_PATH, originalConfig);
        }
        console.log(
            `sshd rejected the portsecure config, rolled it back. `
            + `${(validation.stdout + validation.stderr).trim().slice(0, MAX_ERROR_BODY_LENGTH)}`
        );
        return;
    }

    let unit = await restartSSHD();
    console.log(`Password authentication disabled, reloaded ${unit}`);
}
