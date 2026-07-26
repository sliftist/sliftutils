import os from "os";
import fs from "fs";
import net from "net";
import { SocketFunction } from "socket-function/SocketFunction";
import { getNodeIdLocation } from "socket-function/src/nodeCache";
import { timeInMinute } from "socket-function/src/misc";
import { delay } from "socket-function/src/batching";
import { getExternalIP } from "socket-function/src/networking";
import { forwardPort } from "socket-function/src/forwardPort";
import { magenta } from "socket-function/src/formatting/logColors";
import { getOwnMachineId, getThreadKeyCert, loadIdentityCA, getIdentityCA, createX509, generateKeyPair } from "./certs";
import { generateCert, getAccountKey, parseCert } from "./httpsCerts";
import { setRecord } from "./dns";
import { setHostsEntry } from "./hostsFile";

// A self-signed cert is signed by our own CA and never renews via ACME, so it gets a long life
const SELF_SIGNED_LIFESPAN = 1000 * 60 * 60 * 24 * 365 * 10;

// Renew somewhere randomly between 40% and 60% of the way through the cert lifetime. The random threshold staggers parallel processes on the same machine, so usually one process renews early, and the others see the renewed cert on disk (we re-read the disk before every renewal check) and never renew themselves.
const RENEW_THRESHOLD_MIN = 0.4;
const RENEW_THRESHOLD_MAX = 0.6;
const CERT_CHECK_INTERVAL = timeInMinute * 15;

// One threshold per process, so a process is consistently early or late relative to its siblings
const renewThreshold = RENEW_THRESHOLD_MIN + Math.random() * (RENEW_THRESHOLD_MAX - RENEW_THRESHOLD_MIN);

export type HostServerConfig = {
    /** Full domain to host on (e.g. "testsite.example.com"). The HTTPS cert is created for this domain and *.domain, so using a subdomain never touches the root domain (beyond its _acme-challenge TXT record). */
    domain: string;
    port: number;

    // TODO: Eventually we should support running without Cloudflare API tokens. It's annoying though as the user will have to create a self-signed certificate and then they'll have to go through and trust it everywhere, and a lot of the stuff is transparent, and so it'll have to be non-transparent, getting the user to go to the page that owns the domain and trust it from there. It's much better just make a Cloudflare account. You can buy a domain for $15 a year, and then you can use it for GitHub pages to host your own site and do all kinds of things just like any other real site.
    /** Creates an unproxied A record pointing domain at this machine (publicIp, or our detected external IP) */
    setDNSRecord?: boolean;
    publicIp?: string;
    allowHostnames?: string[];
    /** LAN-only: do NOT forward the port (no UPnP/NAT mapping), for a server reachable only on the local network. */
    internal?: boolean;
    /** Serve a TLS cert signed by this machine's CA instead of obtaining a real (ACME) one. See getFreshHTTPSCert. */
    selfSigned?: boolean;
    /** When the port is busy (e.g. the previous deploy still holds it), mount on an alternate port instead (the socket server's built-in free-port scan), and keep trying to take the real port - once it frees, a raw TCP relay on the real port forwards to our listener (SocketFunction can only mount once per process). */
    portFallback?: {
        /** Delay until the next main-port acquisition attempt (tightened around the predecessor's scheduled death) */
        getAcquireDelay: () => number;
        /** Called when the main port turned out to be busy, before we act as its successor in any way. Throwing aborts startup - a busy port with no deploy in progress means something else holds it, which is not a state to keep running in. */
        onPortInUse?: () => Promise<void>;
        /** Reports every port we become reachable on (the alternate at mount, the main port once relayed) */
        onListening: (port: number, isMainPort: boolean) => void;
    };
};

/** Hosts a SocketFunction server on a real domain, with an automatically created and renewed Let's Encrypt HTTPS certificate (cached in the home folder, shared between processes on the machine). Expose your controllers (and any RequireController setup) before calling this. Returns the mounted nodeId. */
export async function hostServer(config: HostServerConfig): Promise<string> {
    let { domain, port } = config;
    // The identity CA always lives on the root domain (nodeIds are threadHash.machineHash.root.tld)
    let rootDomain = domain.split(".").slice(-2).join(".");
    await loadIdentityCA(rootDomain);

    if (config.setDNSRecord) {
        let ip = config.publicIp || await getExternalIP();
        if (config.selfSigned) {
            // A self-signed server uses no Cloudflare at all (no ACME challenge and no public DNS record), so we resolve the ip-domain through THIS machine's hosts file instead. Other machines that need to reach it must resolve the domain themselves (a real DNS record, or the same hosts entry).
            setHostsEntry({ ip, hostname: domain });
            setHostsEntry({ ip: "127.0.0.1", hostname: "127-0-0-1." + rootDomain });
        } else {
            await setRecord("A", domain, ip);
        }
    }

    let keyCert = await getFreshHTTPSCert(domain, config.selfSigned);
    let certListeners: ((value: { key: string; cert: string }) => void)[] = [];
    void runCertRenewalLoop(domain, config.selfSigned, newKeyCert => {
        keyCert = newKeyCert;
        for (let listener of certListeners) {
            listener(newKeyCert);
        }
    });

    // With portFallback, a busy port is not an error: the underlying server scans for a free port instead (useAvailablePortIfPortInUse), and the nodeId tells us which port we actually got
    let nodeId = await SocketFunction.mount({
        public: true,
        // --internal servers are LAN-only, so we never open a port on the router
        autoForwardPort: !config.internal,
        port,
        useAvailablePortIfPortInUse: !!config.portFallback,
        ...getThreadKeyCert(rootDomain),
        SNICerts: {
            [domain]: callback => {
                callback(keyCert);
                certListeners.push(callback);
            },
            [getOwnMachineId(rootDomain) + "." + rootDomain]: async callback => {
                let threadCert = await getThreadKeyCert(rootDomain);
                callback({
                    key: threadCert.key,
                    cert: threadCert.cert,
                });
            },
            ["127-0-0-1." + rootDomain]: async callback => {
                callback(keyCert);
                certListeners.push(callback);
            },
        },
        allowHostnames: config.allowHostnames,
    });
    let servingPort = getNodeIdLocation(nodeId)?.port || port;
    let fallback = config.portFallback;
    if (fallback && servingPort !== port) {
        console.warn(`Port ${port} is in use (presumably by our predecessor); serving on alternate port ${servingPort} until it frees`);
        await fallback.onPortInUse?.();
        void runMainPortAcquireLoop(domain, port, servingPort, fallback, !!config.internal);
    }
    fallback?.onListening(servingPort, servingPort === port);
    console.log(magenta(`Hosting https://${domain}:${servingPort} (nodeId ${nodeId})`));
    return nodeId;
}

// SocketFunction can only mount once per process, so "taking over" the main port is a raw TCP relay forwarding to our real listener - TLS/SNI passes straight through, and clients address servers by ip domain (wildcard negotiation), so the extra hop is invisible.
async function runMainPortAcquireLoop(domain: string, mainPort: number, servingPort: number, fallback: NonNullable<HostServerConfig["portFallback"]>, internal: boolean): Promise<void> {
    while (true) {
        await delay(fallback.getAcquireDelay());
        let acquired = await new Promise<boolean>(resolve => {
            let relay = net.createServer(client => {
                let upstream = net.connect({ host: "127.0.0.1", port: servingPort });
                // Without this every relayed request pays the ~40ms delayed-ACK timer: a call is a small write (often a header then a body), Nagle holds the second write until the first is acknowledged, and the peer has nothing to piggyback the ACK on. Measured as 43ms per call through the relay versus 1ms direct.
                client.setNoDelay(true);
                upstream.setNoDelay(true);
                client.pipe(upstream);
                upstream.pipe(client);
                let cleanup = () => {
                    client.destroy();
                    upstream.destroy();
                };
                client.on("error", cleanup);
                upstream.on("error", cleanup);
            });
            relay.once("error", () => resolve(false));
            relay.listen(mainPort, () => resolve(true));
        });
        if (acquired) {
            console.log(magenta(`Acquired main port ${mainPort} for https://${domain} (relaying to our listener on ${servingPort})`));
            // The mount only forwarded OUR serving port; the main port needs its own mapping (the predecessor's mapping pointed at the same machine+port, but dies with it). LAN-only (--internal) servers never open router ports.
            if (!internal) {
                await forwardPort({ externalPort: mainPort, internalPort: mainPort });
            }
            fallback.onListening(mainPort, true);
            return;
        }
    }
}

// Self-signed certs cache under a distinct name, so switching a domain between ACME and self-signed never reads back the wrong kind
function getCertDiskPath(domain: string, selfSigned?: boolean) {
    return os.homedir() + `/httpscert_${selfSigned ? "selfsigned_" : ""}${domain}.json`;
}
function readCertFromDisk(domain: string, selfSigned?: boolean): { key: string; cert: string } | undefined {
    try {
        return JSON.parse(fs.readFileSync(getCertDiskPath(domain, selfSigned), "utf8")) as { key: string; cert: string };
    } catch {
        return undefined;
    }
}

// A TLS cert for `domain` signed by this machine's identity CA, presented as a chain (leaf + CA) so a client that trusts the CA validates it. The key part of the ip-domain scheme is unchanged: browsers ignore nameConstraints and validate the SAN + chain; a browser that hasn't trusted the CA prompts the user, who accepts it once (the trust-cert flow), and node peers trust it via the CA.
function generateSelfSignedCert(domain: string): { key: string; cert: string } {
    let rootDomain = domain.split(".").slice(-2).join(".");
    let ca = getIdentityCA(rootDomain);
    let leaf = createX509({ domain, issuer: ca, keyPair: generateKeyPair(), lifeSpan: SELF_SIGNED_LIFESPAN });
    return { key: leaf.key.toString(), cert: leaf.cert.toString() + "\n" + ca.cert.toString() };
}
function getRenewTime(certPem: string, threshold: number) {
    let certObj = parseCert(certPem);
    let start = +new Date(certObj.validity.notBefore);
    let end = +new Date(certObj.validity.notAfter);
    return start + (end - start) * threshold;
}

/** Returns the cached HTTPS cert for the domain, creating/renewing it first if it is past this process's renewal threshold. Reads the disk cache on every call, so a renewal done by a parallel process is picked up instead of renewing again. selfSigned: sign it with this machine's CA instead of getting a real ACME cert. */
export async function getFreshHTTPSCert(domain: string, selfSigned?: boolean): Promise<{ key: string; cert: string }> {
    let keyCert = readCertFromDisk(domain, selfSigned);
    if (keyCert && getRenewTime(keyCert.cert, renewThreshold) > Date.now()) {
        return keyCert;
    }
    if (selfSigned) {
        // Cached so the served cert is stable across restarts (a browser's accepted-certificate exception is per exact cert)
        console.log(magenta(keyCert ? `Self-signed cert for ${domain} is expiring, regenerating` : `No self-signed cert on disk for ${domain}, creating one (signed by this machine's CA)`));
        let generated = generateSelfSignedCert(domain);
        fs.writeFileSync(getCertDiskPath(domain, true), JSON.stringify(generated));
        return generated;
    }
    if (keyCert) {
        console.log(magenta(`HTTPS cert for ${domain} is past ${(renewThreshold * 100).toFixed(0)}% of its lifetime, renewing`));
    } else {
        console.log(magenta(`No HTTPS cert on disk for ${domain}, creating one`));
    }
    let accountKey = await getAccountKey(domain);
    try {
        keyCert = await generateCert({ accountKey, domain, altDomains: ["*." + domain] });
    } catch (e) {
        if (String(e).includes("authorization must be pending")) {
            // Another process is mid-renewal. Wait for it to finish, then re-check the disk.
            console.log(`Certificate authorization is pending in another process, waiting 2 minutes`);
            await delay(timeInMinute * 2);
            return await getFreshHTTPSCert(domain);
        }
        throw e;
    }
    fs.writeFileSync(getCertDiskPath(domain), JSON.stringify({ key: keyCert.key, cert: keyCert.cert }));
    return { key: keyCert.key, cert: keyCert.cert };
}

async function runCertRenewalLoop(domain: string, selfSigned: boolean | undefined, onNewCert: (keyCert: { key: string; cert: string }) => void) {
    let lastCert = readCertFromDisk(domain, selfSigned)?.cert;
    while (true) {
        await delay(CERT_CHECK_INTERVAL);
        try {
            let keyCert = await getFreshHTTPSCert(domain, selfSigned);
            if (keyCert.cert !== lastCert) {
                lastCert = keyCert.cert;
                console.log(magenta(`HTTPS cert for ${domain} updated, applying to running server`));
                onNewCert(keyCert);
            }
        } catch (e) {
            console.error(`Failed to check/renew HTTPS cert for ${domain}`, e);
        }
    }
}
