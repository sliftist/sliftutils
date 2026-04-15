
import { addRecord, deleteRecord, getRecords, setRecord } from "./dns";
import { cache, lazy } from "socket-function/src/caching";
import * as forge from "node-forge";
import acme from "acme-client";
import { magenta, red } from "socket-function/src/formatting/logColors";
import { formatDateTime, formatTime } from "socket-function/src/formatting/format";
import { timeInHour, timeInMinute } from "socket-function/src/misc";
import { delay } from "socket-function/src/batching";
import fs from "fs";
import { getKeyStore } from "./persistentLocalStorage";

// For example:
/*
let domain = "querysubtest.com";
await loadIdentityCA(domain);

let listenPublic = false;
let port = 9823;
let localDomain = "127-0-0-1." + domain;
await addRecord("A", localDomain, "127.0.0.1");
let keyCert = await getHTTPSCert(domain);
*/

// Expire EXPIRATION_THRESHOLD% of the way through the certificate's lifetime
const EXPIRATION_THRESHOLD = 0.4;

/** NOTE: We also generate the domain *.domain */
export const getHTTPSCert = cache(async (domain: string): Promise<{ key: string; cert: string }> => {
    if (!domain.endsWith(".")) {
        domain = domain + ".";
    }

    // No matter what, reset this from the in-memory cache in an hour. This is fine. We'll just see the cache on disk and see that it hasn't expired. Or we might see that it has expired, and then we will get the new value. 
    setTimeout(() => {
        getHTTPSCert.clear(domain);
    }, timeInHour);

    let keyCert: { key: string; cert: string } | undefined;
    let path = domain + ".cert";

    try {
        keyCert = JSON.parse(fs.readFileSync(path, "utf8")) as { key: string; cert: string };
    } catch { }
    if (keyCert) {
        // If 40% of the lifetime has passed, renew it (has to be < the threshold
        //  in EdgeCertController).
        let certObj = parseCert(keyCert.cert);
        let expirationTime = +new Date(certObj.validity.notAfter);
        let createTime = +new Date(certObj.validity.notBefore);
        let renewDate = createTime + (expirationTime - createTime) * EXPIRATION_THRESHOLD;
        if (renewDate < Date.now()) {
            console.log(magenta(`Renewing domain ${domain} (renew target is ${formatDateTime(renewDate)}).`));
            keyCert = undefined;
        }
    } else {
        console.log(magenta(`No cert found for domain ${domain}, generating shortly.`));
    }
    if (keyCert) {
        return keyCert;
    }

    const accountKey = await getAccountKey(domain);
    let altDomains: string[] = [];

    // altDomains.push("noproxy." + domain);
    // // NOTE: Allowing local access is just an optimization, not to avoid having to forward ports
    // //  (unless you type 127-0-0-1.domain into the browser... then I guess you don't have to forward ports?)
    // altDomains.push("127-0-0-1." + domain);

    // NOTE: I forget why we were not allowing wildcard domains. I think it was to prevent
    //  any HTTPS domains from impersonating servers. But... servers have two levels, so that isn't
    //  an issue. And even if they didn't they store their public key in their domain, so you
    //  can't really impersonate them anyways...
    //  - AND, we need this for IP type A records, which... we need to pick the server we want
    //      to connect to.
    altDomains.push("*." + domain);

    try {
        keyCert = await generateCert({ accountKey, domain, altDomains });
    } catch (e) {
        if (String(e).includes("authorization must be pending")) {
            console.log(`Authorization appears to be pending, waiting 2 minutes for other process to create certificate`);
            await delay(timeInMinute * 2);
            return await getHTTPSCert(domain);
        }
        throw e;
    }
    await fs.promises.writeFile(path, JSON.stringify(keyCert));
    return keyCert;
});


const getAccountKey = async function getAccountKey(domain: string) {
    let accountKey = getKeyStore<string>(domain, "letsEncryptAccountKey");
    let secret = await accountKey.get();
    if (!secret) {
        // Should only HAPPEN ONCE, EVER!
        console.error(red(`Generating new letsencrypt account key`));
        const keyPair = forge.pki.rsa.generateKeyPair();
        secret = forge.pki.privateKeyToPem(keyPair.privateKey);
        await accountKey.set(secret);
    }
    return secret;
};


function parseCert(PEMorDER: string | Buffer) {
    return forge.pki.certificateFromPem(normalizeCertToPEM(PEMorDER));
}

function normalizeCertToPEM(PEMorDER: string | Buffer): string {
    if (PEMorDER.toString().startsWith("-----BEGIN CERTIFICATE-----")) {
        return PEMorDER.toString();
    }
    PEMorDER = PEMorDER.toString("base64");
    return "-----BEGIN CERTIFICATE-----\n" + PEMorDER + "\n-----END CERTIFICATE-----";
}


async function generateCert(config: {
    accountKey: string;
    domain: string;
    altDomains?: string[];
}): Promise<{
    domains: string[];
    key: string;
    cert: string;
}> {
    let { accountKey, domain } = config;

    console.log(magenta(`Generating new cert for ${domain}`));

    let domainList = [domain, ...config.altDomains || []];
    // Strip trailing "."
    domainList = domainList.map(x => x.endsWith(".") ? x.slice(0, -1) : x);

    const [certificateKey, certificateCsr] = await acme.forge.createCsr({
        commonName: domainList[0],
        altNames: domainList.slice(1),
    });

    // So... acme-client is fine. Just re-implement the "auto" mode ourselves, to have more control over it.
    const client = new acme.Client({
        directoryUrl: acme.directory.letsencrypt.production,
        accountKey: accountKey,
    });

    const accountPayload = {
        termsOfServiceAgreed: true,
        contact: [`mailto:devops@perspectanalytics.com`],
    };

    try {
        await client.getAccountUrl();
    } catch {
        await client.createAccount(accountPayload);
    }

    const orderPayload = {
        identifiers: domainList.map(domain => ({ type: "dns", value: domain })),
    };
    const order = await client.createOrder(orderPayload);
    const authorizations = await client.getAuthorizations(order);
    console.log(`Starting authorizations: ${JSON.stringify(authorizations)}`);

    for (let auth of authorizations) {
        if (auth.status === "valid") {
            console.log(`Authorization already valid for ${auth.identifier.value}`);
            continue;
        }
        console.log(`Starting authorization for ${JSON.stringify(auth)}`);

        // Only use DNS authorization
        let challenge = auth.challenges.find(x => x.type === "dns-01");
        if (!challenge) {
            throw new Error("No DNS challenge found");
        }
        const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);

        let hostname = auth.identifier.value;
        let challengeRecordName = "_acme-challenge." + hostname + ".";
        await setRecord("TXT", challengeRecordName, keyAuthorization);

        await client.completeChallenge(challenge);
        console.log(`Challenge completed`);

        await client.waitForValidStatus(challenge);
        console.log(`Status of order is valid`);
    }

    const finalized = await client.finalizeOrder(order, certificateCsr);
    console.log(`Order finalized`);

    let cert = await client.getCertificate(finalized);
    return {
        domains: domainList,
        key: certificateKey.toString(),
        cert: cert,
    };
}
