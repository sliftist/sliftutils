import { DEV_listIdentityDomains, getOwnMachineId, loadIdentityCA } from "../../misc/https/certs";

// Prints this machine's id under every domain it has an identity for. A machine has a different
// identity, and so a different machine id, under every domain it runs under.
async function main() {
    let domains = DEV_listIdentityDomains();
    if (!domains.length) {
        throw new Error(`This machine has no identities`);
    }
    for (let domain of domains) {
        await loadIdentityCA(domain);
        console.log(`${domain} ${getOwnMachineId(domain)}`);
    }
}

main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
