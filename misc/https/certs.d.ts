/// <reference path="node-forge-ed25519.d.ts" />
/// <reference path="../../storage/storage.d.ts" />
/// <reference types="node" />
/// <reference types="node" />
import * as forge from "node-forge";
import { MaybePromise } from "socket-function/src/types";
export declare const CA_NOT_FOUND_ERROR = "18aa7318-f88f-4d2d-b41f-3daf4a433827";
export declare const identityStorageKey = "machineCA_10";
export type IdentityStorageType = {
    domain: string;
    certB64: string;
    keyB64: string;
};
export interface X509KeyPair {
    domain: string;
    cert: Buffer;
    key: Buffer;
}
export declare function getCommonName(cert: Buffer | string): string;
export declare function createX509(config: {
    domain: string;
    issuer: X509KeyPair | "self";
    lifeSpan: number;
    keyPair: {
        publicKey: forge.Ed25519PublicKey;
        privateKey: forge.Ed25519PrivateKey;
    } | forge.pki.KeyPair;
}): X509KeyPair;
export declare function privateKeyToPem(buffer: forge.pki.PrivateKey | forge.Ed25519PrivateKey): string;
export declare function parseCert(PEMorDER: string | Buffer): forge.pki.Certificate;
export declare function getPublicIdentifier(PEMorDER: string | Buffer): Buffer;
export declare const sign: (keyPair: {
    key: string | Buffer;
}, data: unknown) => string;
export declare function verify(cert: string, signature: string, data: unknown): boolean;
export declare function validateCACert(domain: string, cert: string | Buffer): void;
export declare function validateCertificate(domain: string, cert: Buffer | string, issuerCert: Buffer | string): void;
export declare function generateKeyPair(): forge.pki.rsa.KeyPair;
export declare function generateRSAKeyPair(): forge.pki.rsa.KeyPair;
export declare function generateTestCA(domain: string): X509KeyPair;
export declare function createCertFromCA(config: {
    CAKeyPair: X509KeyPair;
}): X509KeyPair;
export declare function getMachineId(domainName: string): string;
export type NodeIdParts = {
    threadId: string;
    machineId: string;
    domain: string;
    port: number;
};
export declare function decodeNodeId(nodeId: string): NodeIdParts | undefined;
export declare function decodeNodeIdAssert(nodeId: string): NodeIdParts;
export declare function encodeNodeId(parts: NodeIdParts): string;
export declare function setIdentityCARaw(domain: string, json: string): Promise<void>;
export declare function loadIdentityCA(domain: string): Promise<void>;
export declare function getIdentityCA(domain: string): X509KeyPair;
export declare function getIdentityCAPromise(domain: string): MaybePromise<X509KeyPair>;
export declare function getOwnMachineId(domain: string): string;
/** Part of the machineId comes from the publicKey, so we can use it to verify */
export declare function verifyMachineIdForPublicKey(config: {
    machineId: string;
    publicKey: Buffer;
}): boolean;
export declare function getThreadKeyCert(domain: string): X509KeyPair;
export declare const createTestBrowserKeyCert: {
    (): Promise<X509KeyPair>;
    reset(): void;
    set(newValue: Promise<X509KeyPair>): void;
};
export declare function getOwnNodeId(): string;
export declare function getOwnNodeIdAllowUndefined(): string;
