import fs from "fs/promises";
import path from "path";
import { runPromise } from "socket-function/src/runPromise";
import { allowAddresses, keyFingerprint, readRepoKeys, summarizeKey } from "./authorizedKeys";
import { revokeRepoURL } from "./revokeSource";
import { signRepo } from "../signedFiles/signFiles";
import { getMachines, setMachines } from "../machines/machines";
import { resolveKeysRepo } from "./keysRepo";
import { readRemoteRevocations, Revocation, revocationIdentity, revocationIP, UNREVOKES_DIR } from "./unrevoke";

const GIT_KEYWORD = "git";
const COMMIT_MESSAGE = "unrevoke keys";
const USAGE = `Usage: yarn unrevoke [keys-repo] [${GIT_KEYWORD}]

Run this in a keys repo, or name one. It reads that repo's revoke repo and writes one unrevoke file
naming every revocation in it, so the keys are accepted again as each machine picks it up. It signs
the result, and with ${GIT_KEYWORD} it commits and pushes it too.

Keys that were revoked should normally be deleted from the repo instead. Unrevoking only matters
for a key you still want.`;

/** Writes the addresses into the from= list of each key in the repo's authorized_keys, and says
    which ones were actually new. Only the lines being changed are touched, so comments, ordering
    and any key not involved come out of this byte for byte the same. */
async function allowAddressesInRepo(config: {
    repoPath: string;
    addressesByFingerprint: Map<string, string[]>;
}) {
    let { repoPath, addressesByFingerprint } = config;
    let added = new Map<string, string[]>();
    let filePath = path.join(repoPath, "authorized_keys");
    let contents;
    try {
        contents = await fs.readFile(filePath, "utf8");
    } catch (e) {
        // A repo holding its keys as separate .pub files. Nothing to edit in one place, so the
        // caller's listing is all whoever ran this gets.
        console.log(`No authorized_keys in ${repoPath}, so the addresses were not added to any key.`);
        return added;
    }
    let lines = contents.split("\n");
    for (let index = 0; index < lines.length; index++) {
        let fingerprint = keyFingerprint(lines[index]);
        let addresses = fingerprint && addressesByFingerprint.get(fingerprint);
        if (!addresses || !addresses.length) {
            continue;
        }
        let result = allowAddresses(lines[index], addresses);
        lines[index] = result.keyLine;
        added.set(fingerprint, [...(added.get(fingerprint) || []), ...result.added]);
    }
    if ([...added.values()].some(list => list.length)) {
        await fs.writeFile(filePath, lines.join("\n"));
    }
    return added;
}

/** Puts each machine's addresses back into its own file, which is the machine equivalent of adding
    an address to a key's from= list: without it the machine is allowed again in principle and
    still rejected on sight, which revokes it once more. */
async function allowAddressesForMachines(config: { repoPath: string; revocations: Revocation[] }) {
    let { repoPath, revocations } = config;
    let added = new Map<string, string[]>();
    // Read the whole list, change what these revocations are about, write it back. Setting is by
    // the whole set, so writing one machine at a time would delete every other machine.
    let machines = await getMachines(repoPath);
    for (let revocation of revocations) {
        let machineId = revocation.machineId;
        let ip = revocationIP(revocation);
        if (!machineId || !ip) {
            continue;
        }
        let existing = machines.find(machine => machine.machineId === machineId);
        if (!existing) {
            // Removed from the repo since it was revoked, so there is nothing to allow. Deleting a
            // machine is the stronger statement and it stands.
            console.log(`machines/${machineId}.json is not in this repo, so ${ip} was not added to it`);
            continue;
        }
        if (existing.ips.includes(ip)) {
            continue;
        }
        existing.ips = [...existing.ips, ip];
        added.set(machineId, [...(added.get(machineId) || []), ip]);
    }
    if (added.size) {
        await setMachines({ repoPath, machines });
    }
    return added;
}

async function main() {
    let argv = process.argv.slice(2);
    let pushToGit = argv.includes(GIT_KEYWORD);
    let positional = argv.filter(arg => arg !== GIT_KEYWORD);
    if (positional.length > 1) {
        throw new Error(`Expected at most a keys repo, was ${positional.length} argument(s)\n${USAGE}`);
    }
    let { repoPath, sourceURL: originURL } = await resolveKeysRepo(positional[0]);

    let revocations = await readRemoteRevocations({ sourceURL: originURL });
    if (!revocations.length) {
        console.log(`${revokeRepoURL(originURL)} lists no revocations, so there is nothing to undo.`);
        return;
    }

    let directory = path.join(repoPath, UNREVOKES_DIR);
    await fs.mkdir(directory, { recursive: true });
    let stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let unrevokeId = `${stamp}-unrevoke`;
    await fs.writeFile(path.join(directory, `${unrevokeId}.json`), JSON.stringify({
        unrevokeId,
        createdAt: new Date().toISOString(),
        // What this file says: each of these keys is allowed from this address. Pairs, not keys,
        // and not a blanket "allow everything again" - a key forgiven here for one address is
        // still revoked the moment it is used from another.
        allowed: revocations.map(revocation => ({
            fingerprint: revocation.fingerprint,
            machineId: revocation.machineId,
            ip: revocationIP(revocation),
        })),
        revocations: revocations.map(revocation => ({
            revocationId: revocation.revocationId,
            fingerprint: revocation.fingerprint,
            machineId: revocation.machineId,
            ip: revocationIP(revocation),
            revokedAt: revocation.revokedAt,
            revokedBy: revocation.revokedBy,
            attempt: revocation.attempt,
        })),
    }, undefined, 4) + "\n");

    // Named the way the notifications name them. A fingerprint is not in authorized_keys and
    // cannot be worked out by eye, so on its own it tells whoever is reading this nothing about
    // which of their keys is being talked about.
    let keysByFingerprint = new Map<string, string>();
    for (let key of await readRepoKeys(repoPath).catch(() => [] as string[])) {
        keysByFingerprint.set(keyFingerprint(key), key);
    }
    let describeKey = (revocation: Revocation) => {
        let key = keysByFingerprint.get(revocation.fingerprint || "") || revocation.key || "";
        return key && summarizeKey(key) || `a key no longer in this repo (${revocation.fingerprint})`;
    };

    let addressesByIdentity = new Map<string, string[]>();
    for (let revocation of revocations) {
        let ip = revocationIP(revocation);
        let identity = revocationIdentity(revocation);
        let existing = addressesByIdentity.get(identity) || [];
        if (ip && !existing.includes(ip)) {
            existing.push(ip);
        }
        addressesByIdentity.set(identity, existing);
    }

    // Cancelling the revocation on its own would leave sshd refusing that address, and the machines
    // revoking all over again, so the addresses go into the key's from= list and into the machine's
    // own file here. We are in the repo that owns both, so there is nothing to hand back to whoever
    // ran this.
    let added = await allowAddressesInRepo({ repoPath, addressesByFingerprint: addressesByIdentity });
    let addedForMachines = await allowAddressesForMachines({ repoPath, revocations });

    console.log("");
    for (let [identity, addresses] of addressesByIdentity) {
        let entries = revocations.filter(entry => revocationIdentity(entry) === identity);
        let machineId = entries[0].machineId;
        console.log(`Unfreezing ${machineId && `machine ${machineId}` || describeKey(entries[0])}`);
        console.log(`Allowing IP ${addresses.join(", ") || "(no address recorded)"}`);
        let addedHere = machineId && addedForMachines.get(machineId) || added.get(identity) || [];
        if (addedHere.length) {
            let where = machineId && `machines/${machineId}.json` || `that key's from= list in authorized_keys`;
            console.log(`  added to ${where}: ${addedHere.join(", ")}`);
        } else {
            console.log(`  already allowed from ${addresses.join(", ") || "everywhere"}`);
        }
        for (let entry of entries) {
            console.log(
                `  frozen by ${entry.revokedBy || "?"} ${entry.revokedAt || "at an unrecorded time"}`
            );
        }
        console.log("");
    }
    console.log(`Every other address stays frozen, and any of these used from anywhere else is`);
    console.log(`frozen again.`);

    // Signed here rather than left as a step to remember. An unrevoke nobody signed does nothing at
    // all, and the repo would sit there looking done while every machine ignored it.
    await signRepo({ repoPath });

    if (!pushToGit) {
        console.log(`\nCommit and push it, and those keys work again as each machine picks it up:`);
        console.log(`\`\`\`\ngit add -A\ngit commit -m "${COMMIT_MESSAGE}"\ngit push\n\`\`\``);
        return;
    }
    await runPromise(`git add -A`, { cwd: repoPath });
    await runPromise(`git commit -m "${COMMIT_MESSAGE}"`, { cwd: repoPath });
    await runPromise(`git push`, { cwd: repoPath });
    console.log(`\nCommitted and pushed. Those keys work again as each machine picks it up.`);
}

main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
