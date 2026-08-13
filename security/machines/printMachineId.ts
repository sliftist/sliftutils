import { getOwnMachineId, loadIdentityCA } from "../../misc/https/certs";

const USAGE = `Usage:
  yarn printmachineid <domain>

The domain is required: a machine has a different identity, and so a different machine id, under
every domain it runs under, so there is no such thing as "this machine" without one.`;

async function main() {
    let [domain] = process.argv.slice(2);
    if (!domain) {
        throw new Error(`Expected a domain\n${USAGE}`);
    }
    await loadIdentityCA(domain);
    console.log(getOwnMachineId(domain));
}

main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
