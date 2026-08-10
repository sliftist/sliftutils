import crypto from "crypto";
import fs from "fs/promises";
import { expandHome } from "../helpers/paths";
import { formatOpenSSHPrivateKey, formatPublicKeyLine, parseOpenSSHPrivateKey, publicKeyFromSeed } from "./sshKeyFile";

const USAGE = `Usage: yarn derivekey <label> <source-key> <derived-key>

Derives a second ed25519 key from an existing one. The same label and source key always give the
same derived key, so it can be worked out again rather than backed up.

  yarn derivekey revokegithubkey ~/authorized_keys_access/id_ed25519 ~/authorized_keys_access/id_ed25519_revoke`;

/** A label mixed into a key's secret to get another key, so one key can stand behind several
    identities without any of them being stored.

    HMAC rather than hashing the two joined together: with a plain hash, anyone who obtained one
    derived key could extend it into further labels without ever knowing the source key. The label
    is the message and the source secret is the key, which is what HMAC is for. */
export function deriveEd25519Key(config: { seed: Buffer; label: string }) {
    let { seed, label } = config;
    if (!label) {
        throw new Error(`Expected a label to derive with, was ${JSON.stringify(label)}`);
    }
    let derivedSeed = crypto.createHmac("sha256", seed).update(label, "utf8").digest();
    return { seed: derivedSeed, publicKey: publicKeyFromSeed(derivedSeed) };
}

async function pathExists(filePath: string) {
    try {
        await fs.access(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

function parseArgs(argv: string[]) {
    if (argv.length !== 3) {
        throw new Error(`Expected a label, a source key and a derived key, was ${argv.length} argument(s)\n${USAGE}`);
    }
    let [label, sourcePath, derivedPath] = argv;
    return { label, sourcePath: expandHome(sourcePath), derivedPath: expandHome(derivedPath) };
}

export async function main() {
    let { label, sourcePath, derivedPath } = parseArgs(process.argv.slice(2));

    if (!await pathExists(sourcePath)) {
        throw new Error(`Expected a source key at ${sourcePath}, no such file exists`);
    }
    // Writing over a key would strand whatever it already gives access to, and the derived key can
    // always be worked out again, so there is never a reason to overwrite.
    if (await pathExists(derivedPath)) {
        throw new Error(
            `Expected ${derivedPath} to not exist, it does. Deriving the same label again gives the`
            + ` same key, so delete it first if you want it rewritten.`
        );
    }

    let source = parseOpenSSHPrivateKey(await fs.readFile(sourcePath, "utf8"));
    let derived = deriveEd25519Key({ seed: source.seed, label });
    let comment = `${source.comment || sourcePath} ${label}`.trim();

    await fs.writeFile(derivedPath, formatOpenSSHPrivateKey({ seed: derived.seed, comment }), { mode: 0o600 });
    let publicLine = formatPublicKeyLine({ publicKey: derived.publicKey, comment });
    await fs.writeFile(`${derivedPath}.pub`, publicLine, { mode: 0o644 });

    console.log(`Derived "${label}" from ${sourcePath}`);
    console.log(`  private ${derivedPath}`);
    console.log(`  public  ${derivedPath}.pub`);
    console.log(publicLine.trim());
}
