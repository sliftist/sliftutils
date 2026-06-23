/// <reference types="node" />
/// <reference types="node" />
import { IStorageRaw } from "./IStorage";
import { RemoteOptions } from "./remoteFileStorage";
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
export type FileWrapper = {
    readonly kind: "file";
    readonly name: string;
    getFile(): Promise<{
        size: number;
        lastModified: number;
        arrayBuffer(): Promise<ArrayBuffer>;
        slice(start: number, end: number): {
            arrayBuffer(): Promise<ArrayBuffer>;
        };
    }>;
    createWritable(config?: {
        keepExistingData?: boolean;
    }): Promise<{
        seek(offset: number): Promise<void>;
        write(value: Buffer): Promise<void>;
        close(): Promise<void>;
    }>;
    getURL?(): Promise<string>;
};
export type DirectoryWrapper = {
    readonly kind: "directory";
    readonly name: string;
    readonly fullPath?: string;
    readonly isRemote?: boolean;
    removeEntry(key: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    getFileHandle(key: string, options?: {
        create?: boolean;
    }): Promise<FileWrapper>;
    getDirectoryHandle(key: string, options?: {
        create?: boolean;
    }): Promise<DirectoryWrapper>;
    entries(): AsyncIterableIterator<[string, FileWrapper | DirectoryWrapper]>;
    [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileWrapper | DirectoryWrapper]>;
};
export declare function setFileAPIKey(key: string): void;
export declare class NodeJSFileHandleWrapper implements FileWrapper {
    private filePath;
    constructor(filePath: string);
    readonly kind: "file";
    get name(): string;
    getFile(): Promise<{
        size: number;
        lastModified: number;
        arrayBuffer: () => Promise<ArrayBuffer>;
        slice: (start: number, end: number) => {
            arrayBuffer: () => Promise<ArrayBuffer>;
        };
    }>;
    getURL(): Promise<string>;
    createWritable(config?: {
        keepExistingData?: boolean;
    }): Promise<{
        seek: (offset: number) => Promise<void>;
        write: (value: Buffer) => Promise<void>;
        close: () => Promise<void>;
    }>;
}
export declare class NodeJSDirectoryHandleWrapper implements DirectoryWrapper {
    private rootPath;
    constructor(rootPath: string);
    readonly kind: "directory";
    get name(): string;
    get fullPath(): string;
    entries(): AsyncIterableIterator<[string, FileWrapper | DirectoryWrapper]>;
    removeEntry(key: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    getFileHandle(key: string, options?: {
        create?: boolean;
    }): Promise<FileWrapper>;
    getDirectoryHandle(key: string, options?: {
        create?: boolean;
    }): Promise<DirectoryWrapper>;
    [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileWrapper | DirectoryWrapper]>;
}
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
export declare const getFileStorageNested2: {
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
    isRemote?: boolean;
};
export declare function wrapHandle(handle: DirectoryWrapper): FileStorage;
export declare function getFileURL(file: FileWrapper): Promise<string>;
export declare function disposeFileURL(url: string): void;
export declare function getRemoteFileStorageFactory(url: string, password: string, options?: RemoteOptions): (pathStr: string) => Promise<FileStorage>;
export declare function tryToLoadPointer(pointer: string): Promise<DirectoryWrapper | undefined>;
