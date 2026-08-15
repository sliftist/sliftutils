import { DEV_listIdentityDomains, getOwnMachineId, loadIdentityCA } from "../../misc/https/certs";
import { resolveKeysRepo } from "../authorizedKeys/keysRepo";
import { listRevocations, readSignedRepo } from "../authorizedKeys/daemon/readSignedRepo";
import { revokeRepo, syncRepoFiles } from "../authorizedKeys/daemon/repoFiles";
import { MACHINES_DIR } from "./machines";

// Who this machine is, and who it believes everyone else is. One command, because working out
// whether a machine is trusted means holding both halves at once: our own id under each domain,
// and the ids the signed repo lists with the addresses each is allowed from.

async function printOwnIds() {
    let domains = DEV_listIdentityDomains();
    if (!domains.length) {
        console.log(`This machine has no identities yet. One is created the first time it needs one.`);
        return;
    }
    console.log(`This machine:`);
    let ids: string[] = [];
    for (let domain of domains) {
        await loadIdentityCA(domain);
        let machineId = getOwnMachineId(domain);
        ids.push(machineId);
        console.log(`    ${domain} ${machineId}`);
    }
    return ids;
}

async function printRepo(ownIds: string[]) {
    let repo;
    try {
        repo = await resolveKeysRepo();
    } catch (e) {
        console.log(`\nNo keys repo to read, so there is nothing to say about who is trusted. ${e}`);
        return;
    }
    let { repoPath, sourceURL } = repo;
    console.log(`\nKeys repo ${repoPath}`);
    console.log(`    from ${sourceURL}`);

    // Pulled first, or a revocation another machine wrote minutes ago is missing from a picture
    // whose whole purpose is to explain why something is being refused.
    try {
        await syncRepoFiles(revokeRepo(sourceURL));
    } catch (e) {
        console.log(`    Could not pull the revocations, showing the ones already here. ${e}`);
    }

    let files;
    try {
        files = (await readSignedRepo({ repoPath, sourceURL })).files;
    } catch (e) {
        console.log(`\nIts signature does not check out, so nothing in it counts. ${e}`);
        return;
    }

    // Only the machine files the signature covers - readSignedRepo has already dropped anything
    // unsigned or frozen, so this is the list this machine would actually accept.
    let machines: { machineId: string; ips: string[] }[] = [];
    for (let [filePath, contents] of files) {
        if (!filePath.startsWith(`${MACHINES_DIR}/`) || !filePath.endsWith(".json")) {
            continue;
        }
        try {
            let parsed = JSON.parse(contents.toString("utf8"));
            machines.push({
                machineId: parsed.machineId || filePath.slice(MACHINES_DIR.length + 1, -".json".length),
                ips: parsed.ips || [],
            });
        } catch (e) {
            console.log(`    Ignoring unreadable ${filePath}. ${e}`);
        }
    }

    console.log(`\nTrusted machines (${machines.length}), and the addresses each may talk from:`);
    for (let machine of machines) {
        let us = ownIds.includes(machine.machineId) && "  <- this machine" || "";
        console.log(`    ${machine.machineId}  ${machine.ips.join(", ") || "(no addresses, so it is never accepted)"}${us}`);
    }

    // Frozen machines are already gone from the list above, which is exactly why they have to be
    // named here - otherwise a machine being refused everywhere simply is not mentioned anywhere.
    let revocations = listRevocations();
    let frozen = revocations.filter(revocation => !revocation.forgiven);
    console.log(`\nFrozen (${frozen.length}), refused everywhere until unrevoked:`);
    for (let revocation of frozen) {
        let us = ownIds.includes(revocation.identity) && "  <- this machine" || "";
        console.log(`    ${revocation.identity}  used from ${revocation.ip || "an unrecorded address"}`
            + `${revocation.revokedAt && ` at ${revocation.revokedAt}` || ""}`
            + `${revocation.revokedBy && `, noticed by ${revocation.revokedBy}` || ""}${us}`);
        console.log(`        ${revocation.revocationId}`);
    }
    if (frozen.length) {
        console.log(`    To give these access again, run in ${repoPath}: yarn unrevoke git`);
    } else {
        console.log(`    (nothing is frozen)`);
    }

    let forgiven = revocations.filter(revocation => revocation.forgiven);
    if (forgiven.length) {
        console.log(`\nRevoked, then allowed again (${forgiven.length}):`);
        for (let revocation of forgiven) {
            console.log(`    ${revocation.identity}  from ${revocation.ip || "an unrecorded address"}`);
        }
    }

    console.log(`\nSigned files (${files.size}):`);
    for (let filePath of [...files.keys()].sort()) {
        console.log(`    ${filePath}`);
    }
}

async function main() {
    let ownIds = await printOwnIds();
    await printRepo(ownIds || []);
}

main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
