/// <reference types="node" />
/// <reference types="node" />
import { IStorageRaw } from "./IStorage";
declare global {
    interface Window {
        showSaveFilePicker(config?: {
            types: {
                description: string;
                accept: {
                    [mimeType: string]: string[];
                };
            }[];
        }): Promise<FileSystemFileHandle>;
        showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
        showOpenFilePicker(config?: {
            types: {
                description: string;
                accept: {
                    [mimeType: string]: string[];
                };
            }[];
        }): Promise<FileSystemFileHandle[]>;
    }
    interface FileSystemDirectoryHandle {
        requestPermission(config?: {
            mode: "read" | "readwrite";
        }): Promise<PermissionState>;
    }
}
type FileWrapper = {
    getFile(): Promise<{
        size: number;
        lastModified: number;
        arrayBuffer(): Promise<ArrayBuffer>;
    }>;
    createWritable(config?: {
        keepExistingData?: boolean;
    }): Promise<{
        seek(offset: number): Promise<void>;
        write(value: Buffer): Promise<void>;
        close(): Promise<void>;
    }>;
};
type DirectoryWrapper = {
    removeEntry(key: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    getFileHandle(key: string, options?: {
        create?: boolean;
    }): Promise<FileWrapper>;
    getDirectoryHandle(key: string, options?: {
        create?: boolean;
    }): Promise<DirectoryWrapper>;
    [Symbol.asyncIterator](): AsyncIterableIterator<[
        string,
        {
            kind: "file";
            name: string;
            getFile(): Promise<FileWrapper>;
        } | {
            kind: "directory";
            name: string;
            getDirectoryHandle(key: string, options?: {
                create?: boolean;
            }): Promise<DirectoryWrapper>;
        }
    ]>;
};
export declare function setFileAPIKey(key: string): void;
export declare const getDirectoryHandle: {
    (): Promise<DirectoryWrapper>;
    reset(): void;
    set(newValue: Promise<DirectoryWrapper>): void;
};
export declare const getFileStorageNested: {
    (key: string): Promise<FileStorage>;
    clear(key: string): void;
    clearAll(): void;
    forceSet(key: string, value: Promise<FileStorage>): void;
    getAllKeys(): string[];
    get(key: string): Promise<FileStorage> | undefined;
};
export declare const getFileStorage: {
    (): Promise<FileStorage>;
    reset(): void;
    set(newValue: Promise<FileStorage>): void;
};
export declare function resetStorageLocation(): void;
export type NestedFileStorage = {
    hasKey(key: string): Promise<boolean>;
    getStorage(key: string): Promise<FileStorage>;
    removeStorage(key: string): Promise<void>;
    getKeys(includeFolders?: boolean): Promise<string[]>;
};
export type FileStorage = IStorageRaw & {
    folder: NestedFileStorage;
};
export {};
