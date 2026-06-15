/// <reference path="node-forge-ed25519.d.ts" />
/// <reference path="../../storage/storage.d.ts" />
/// <reference types="node" />
/// <reference types="node" />
import * as forge from "node-forge";
/** NOTE: We also generate the domain *.domain */
export declare const getHTTPSCert: {
    (key: string): Promise<{
        key: string;
        cert: string;
    }>;
    clear(key: string): void;
    clearAll(): void;
    forceSet(key: string, value: Promise<{
        key: string;
        cert: string;
    }>): void;
    getAllKeys(): string[];
    get(key: string): Promise<{
        key: string;
        cert: string;
    }> | undefined;
};
export declare const getAccountKey: (domain: string) => Promise<string>;
export declare function parseCert(PEMorDER: string | Buffer): forge.pki.Certificate;
export declare function normalizeCertToPEM(PEMorDER: string | Buffer): string;
export declare function generateCert(config: {
    accountKey: string;
    domain: string;
    altDomains?: string[];
}): Promise<{
    domains: string[];
    key: string;
    cert: string;
}>;
