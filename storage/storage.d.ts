

declare module "node-forge" {
    declare type Ed25519PublicKey = {
        publicKeyBytes: Buffer;
    } & Buffer;
    declare type Ed25519PrivateKey = {
        privateKeyBytes: Buffer;
    } & Buffer;
    class ed25519 {
        static generateKeyPair(): { publicKey: Ed25519PublicKey, privateKey: Ed25519PrivateKey };
        static privateKeyToPem(key: Ed25519PrivateKey): string;
        static privateKeyFromPem(pem: string): Ed25519PrivateKey;
        static publicKeyToPem(key: Ed25519PublicKey): string;
        static publicKeyFromPem(pem: string): Ed25519PublicKey;
    }
}


interface FileSystemDirectoryHandle {
    [Symbol.asyncIterator](): AsyncIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
    requestPermission(config: { mode: "read" | "readwrite" }): Promise<void>;
}
interface FileSystemFileHandle {
    getFile(): File;
    createWritable(): FileSystemWritableFileStream;
}

interface Window {
    showSaveFilePicker(config?: {
        types: {
            description: string; accept: { [mimeType: string]: string[] }
        }[];
    }): Promise<FileSystemFileHandle>;
    showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
    showOpenFilePicker(config?: {
        types: {
            description: string; accept: { [mimeType: string]: string[] }
        }[];
    }): Promise<FileSystemFileHandle[]>;
}