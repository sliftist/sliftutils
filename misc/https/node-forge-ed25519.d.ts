

declare module "node-forge" {
    declare type Ed25519PublicKey = {
        publicKeyBytes: Buffer;
        keyType: string;
        verify(message: string | Buffer, signature: string): boolean;
    };
    declare type Ed25519PrivateKey = {
        privateKeyBytes: Buffer;
        keyType: string;
        sign(message: string | Buffer): string;
    };
    class ed25519 {
        static generateKeyPair(): { publicKey: Ed25519PublicKey, privateKey: Ed25519PrivateKey };
        static privateKeyToPem(key: Ed25519PrivateKey): string;
        static privateKeyFromPem(pem: string): Ed25519PrivateKey;
        static publicKeyToPem(key: Ed25519PublicKey): string;
        static publicKeyFromPem(pem: string): Ed25519PublicKey;
    }
}
