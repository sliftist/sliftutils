/// <reference types="node" />
/// <reference types="node" />
import { IStorageRaw } from "./IStorage";
export declare class PrivateFileSystemStorage implements IStorageRaw {
    private path;
    private rootHandle;
    constructor(path: string);
    private ensureInitialized;
    private directoryExists;
    private getDirectoryHandle;
    private getFileHandle;
    private fileExists;
    get(key: string): Promise<Buffer | undefined>;
    set(key: string, value: Buffer): Promise<void>;
    append(key: string, value: Buffer): Promise<void>;
    remove(key: string): Promise<void>;
    getKeys(): Promise<string[]>;
    getInfo(key: string): Promise<undefined | {
        size: number;
        lastModified: number;
    }>;
    reset(): Promise<void>;
}
