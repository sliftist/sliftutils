import preact from "preact";
import { getFileSystemPointer, storeFileSystemPointer } from "./fileSystemPointer";
import { observable } from "mobx";
import { observer } from "../render-utils/observer";
import { cache, lazy } from "socket-function/src/caching";
import { css, isNode } from "typesafecss";
import { IStorageRaw } from "./IStorage";
import { runInSerial } from "socket-function/src/batching";
import { getFileStorageIndexDB } from "./IndexedDBFileFolderAPI";
import fs from "fs";
import path from "path";

declare global {
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
    interface FileSystemDirectoryHandle {
        requestPermission(config?: { mode: "read" | "readwrite" }): Promise<PermissionState>;
    }
}


// NOTE: IndexedDB is required for iOS, at least. We MIGHT want to make
//  this a user supported toggle too, so they can choose during runtime if they want it.
// DO NOT enable this is isNode
const USE_INDEXED_DB = false;

type FileWrapper = {
    getFile(): Promise<{
        size: number;
        lastModified: number;
        arrayBuffer(): Promise<ArrayBuffer>;
    }>;
    createWritable(config?: { keepExistingData?: boolean }): Promise<{
        seek(offset: number): Promise<void>;
        write(value: Buffer): Promise<void>;
        close(): Promise<void>;
    }>;
};
type DirectoryWrapper = {
    removeEntry(key: string, options?: { recursive?: boolean }): Promise<void>;
    getFileHandle(key: string, options?: { create?: boolean }): Promise<FileWrapper>;
    getDirectoryHandle(key: string, options?: { create?: boolean }): Promise<DirectoryWrapper>;
    [Symbol.asyncIterator](): AsyncIterableIterator<[string, {
        kind: "file";
        name: string;
        getFile(): Promise<FileWrapper>;
    } | {
        kind: "directory";
        name: string;
        getDirectoryHandle(key: string, options?: { create?: boolean }): Promise<DirectoryWrapper>;
    }]>;
};

let displayData = observable({
    ui: undefined as undefined | preact.ComponentChildren,
}, undefined, { deep: false });

let fileAPIKey = "";
function getFileAPIKey() {
    if (!fileAPIKey) throw new Error("Must call setFileAPIKey before using file system. Just pass any key. This prevents reusing the file system api that other development apps might be using.");
    return fileAPIKey;
}
export function setFileAPIKey(key: string) {
    fileAPIKey = key;
}

@observer
class DirectoryPrompter extends preact.Component {
    render() {
        if (!displayData.ui) return undefined;
        return (
            <div className={
                css.position("fixed").pos(0, 0).size("100vw", "100vh")
                    .zIndex(1)
                    .background("white")
                    .center
                    .fontSize(40)
            }>
                {displayData.ui}
            </div>
        );
    }
}

class NodeJSFileHandleWrapper implements FileWrapper {
    constructor(private filePath: string) {
    }

    async getFile() {
        const stats = await fs.promises.stat(this.filePath);
        return {
            size: stats.size,
            lastModified: stats.mtimeMs,
            arrayBuffer: async () => {
                const buffer = await fs.promises.readFile(this.filePath);
                return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
            }
        };
    }

    async createWritable(config?: { keepExistingData?: boolean }) {
        let fileHandle: fs.promises.FileHandle;
        const flags = config?.keepExistingData ? "r+" : "w";

        // Ensure the directory exists
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });

        // Open or create the file
        if (config?.keepExistingData && await fs.promises.access(this.filePath).then(() => true).catch(() => false)) {
            fileHandle = await fs.promises.open(this.filePath, flags);
        } else {
            fileHandle = await fs.promises.open(this.filePath, "w");
        }

        let position = 0;

        return {
            seek: async (offset: number) => {
                position = offset;
            },
            write: async (value: Buffer) => {
                await fileHandle.write(value, 0, value.length, position);
                position += value.length;
            },
            close: async () => {
                await fileHandle.close();
            }
        };
    }
}

class NodeJSDirectoryHandleWrapper implements DirectoryWrapper {
    constructor(private rootPath: string) {
    }

    async removeEntry(key: string, options?: { recursive?: boolean }) {
        const entryPath = path.join(this.rootPath, key);
        if (options?.recursive) {
            await fs.promises.rm(entryPath, { recursive: true, force: true });
        } else {
            await fs.promises.unlink(entryPath);
        }
    }

    async getFileHandle(key: string, options?: { create?: boolean }): Promise<FileWrapper> {
        const filePath = path.join(this.rootPath, key);

        const exists = await fs.promises.access(filePath).then(() => true).catch(() => false);

        if (!exists && options?.create) {
            // Ensure the directory exists
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            // Create the file
            await fs.promises.writeFile(filePath, Buffer.alloc(0));
        } else if (!exists) {
            throw new Error(`File not found: ${filePath}`);
        }

        return new NodeJSFileHandleWrapper(filePath);
    }

    async getDirectoryHandle(key: string, options?: { create?: boolean }): Promise<DirectoryWrapper> {
        const dirPath = path.join(this.rootPath, key);

        if (options?.create) {
            await fs.promises.mkdir(dirPath, { recursive: true });
        } else {
            const exists = await fs.promises.access(dirPath).then(() => true).catch(() => false);
            if (!exists) {
                throw new Error(`Directory not found: ${dirPath}`);
            }
        }

        return new NodeJSDirectoryHandleWrapper(dirPath);
    }

    async *[Symbol.asyncIterator](): AsyncIterableIterator<[string, {
        kind: "file";
        name: string;
        getFile(): Promise<FileWrapper>;
    } | {
        kind: "directory";
        name: string;
        getDirectoryHandle(key: string, options?: { create?: boolean }): Promise<DirectoryWrapper>;
    }]> {
        // Ensure directory exists
        await fs.promises.mkdir(this.rootPath, { recursive: true });

        const entries = await fs.promises.readdir(this.rootPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isFile()) {
                yield [entry.name, {
                    kind: "file",
                    name: entry.name,
                    getFile: async () => new NodeJSFileHandleWrapper(path.join(this.rootPath, entry.name))
                }];
            } else if (entry.isDirectory()) {
                const dirPath = path.join(this.rootPath, entry.name);
                yield [entry.name, {
                    kind: "directory",
                    name: entry.name,
                    getDirectoryHandle: async (key: string, options?: { create?: boolean }) => {
                        return new NodeJSDirectoryHandleWrapper(dirPath).getDirectoryHandle(key, options);
                    }
                }];
            }
        }
    }
}


// NOTE: Blocks until the user provides a directory
export const getDirectoryHandle = lazy(async function getDirectoryHandle(): Promise<DirectoryWrapper> {
    if (isNode()) {
        return new NodeJSDirectoryHandleWrapper(path.resolve("./data/"));
    }
    let root = document.createElement("div");
    document.body.appendChild(root);
    preact.render(<DirectoryPrompter />, root);
    try {

        let handle: DirectoryWrapper | undefined;

        const storedId = localStorage.getItem(getFileAPIKey());
        if (storedId) {
            let doneLoad = false;
            setTimeout(() => {
                if (doneLoad) return;
                console.log("Waiting for user to click");
                displayData.ui = "Click anywhere to allow file system access";
            }, 500);
            try {
                handle = await tryToLoadPointer(storedId);
            } catch (e) {
                console.error(e);
                // Check if the error is due to user activation being required
                const errorMessage = e instanceof Error ? e.message : String(e);
                if (errorMessage.includes("user activation") || errorMessage.includes("User activation")) {
                    doneLoad = true;
                    // Show UI to get user to click and retry
                    let retryCallback: (success: boolean) => void;
                    let retryPromise = new Promise<boolean>(resolve => {
                        retryCallback = resolve;
                    });
                    displayData.ui = (
                        <button
                            className={css.fontSize(40).pad2(80, 40)}
                            onClick={async () => {
                                displayData.ui = "Loading...";
                                try {
                                    const retryHandle = await tryToLoadPointer(storedId);
                                    if (retryHandle) {
                                        handle = retryHandle;
                                        retryCallback(true);
                                    } else {
                                        retryCallback(false);
                                    }
                                } catch (retryError) {
                                    console.error("Retry failed:", retryError);
                                    retryCallback(false);
                                }
                            }}
                        >
                            Click to restore file system access
                        </button>
                    );
                    const success = await retryPromise;
                    if (handle) {
                        return handle;
                    }
                }
            }
            doneLoad = true;
            if (handle) {
                return handle;
            }
        }
        let fileCallback: (handle: DirectoryWrapper) => void;
        let promise = new Promise<DirectoryWrapper>(resolve => {
            fileCallback = resolve;
        });
        displayData.ui = (
            <button
                className={css.fontSize(40).pad2(80, 40)}
                onClick={async () => {
                    console.log("Waiting for user to give permission");
                    const handle = await window.showDirectoryPicker();
                    await handle.requestPermission({ mode: "readwrite" });
                    let storedId = await storeFileSystemPointer({ mode: "readwrite", handle });
                    localStorage.setItem(getFileAPIKey(), storedId);
                    fileCallback(handle as any);
                }}
            >
                Pick Data Directory
            </button>
        );
        return await promise;
    } finally {
        preact.render(null, root);
        root.remove();
    }
});

export const getFileStorageNested = cache(async function getFileStorage(path: string): Promise<FileStorage> {
    let base = await getDirectoryHandle();
    for (let part of path.split("/")) {
        if (!part) continue;
        base = await base.getDirectoryHandle(part, { create: true });
    }
    return wrapHandle(base);
});
export const getFileStorage = lazy(async function getFileStorage(): Promise<FileStorage> {
    if (USE_INDEXED_DB) {
        return await getFileStorageIndexDB();
    }

    let handle = await getDirectoryHandle();
    return wrapHandle(handle);
});
export function resetStorageLocation() {
    localStorage.removeItem(getFileAPIKey());
    window.location.reload();
}

export type NestedFileStorage = {
    hasKey(key: string): Promise<boolean>;
    getStorage(key: string): Promise<FileStorage>;
    removeStorage(key: string): Promise<void>;
    getKeys(includeFolders?: boolean): Promise<string[]>;
};

export type FileStorage = IStorageRaw & {
    folder: NestedFileStorage;
};

let appendQueue = cache((key: string) => {
    return runInSerial((fnc: () => Promise<void>) => fnc());
});


async function fixedGetFileHandle(config: {
    handle: DirectoryWrapper;
    key: string;
    create: true;
}): Promise<FileWrapper>;
async function fixedGetFileHandle(config: {
    handle: DirectoryWrapper;
    key: string;
    create?: boolean;
}): Promise<FileWrapper | undefined>;
async function fixedGetFileHandle(config: {
    handle: DirectoryWrapper;
    key: string;
    create?: boolean;
}): Promise<FileWrapper | undefined> {
    if (config.key.includes("/")) {
        throw new Error(`Cannot use folders directly in file system read / writes. Use a wrapper which handles the folder navigation. Path was ${JSON.stringify(config.key)}`);
    }
    // ALWAYS try without create, because the sshfs-win sucks and doesn't support `create: true`? Wtf...
    try {
        return await config.handle.getFileHandle(config.key);
    } catch {
        if (!config.create) return undefined;
    }
    return await config.handle.getFileHandle(config.key, { create: true });
}

function wrapHandleFiles(handle: DirectoryWrapper): IStorageRaw {
    return {
        async getInfo(key: string) {
            try {
                const file = await handle.getFileHandle(key);
                const fileContent = await file.getFile();
                return {
                    size: fileContent.size,
                    lastModified: fileContent.lastModified,
                };
            } catch (error) {
                return undefined;
            }
        },
        async get(key: string): Promise<Buffer | undefined> {
            try {
                const file = await handle.getFileHandle(key);
                const fileContent = await file.getFile();
                const arrayBuffer = await fileContent.arrayBuffer();
                return Buffer.from(arrayBuffer);
            } catch (error) {
                return undefined;
            }
        },

        async append(key: string, value: Buffer): Promise<void> {
            await appendQueue(key)(async () => {
                // NOTE: Interesting point. Chrome doesn't optimize this to be an append, and instead
                //  rewrites the entire file.
                const file = await fixedGetFileHandle({ handle, key, create: true });
                const writable = await file.createWritable({ keepExistingData: true });
                let offset = (await file.getFile()).size;
                await writable.seek(offset);
                await writable.write(value);
                await writable.close();
            });
        },

        async set(key: string, value: Buffer): Promise<void> {
            const file = await fixedGetFileHandle({ handle, key, create: true });
            const writable = await file.createWritable();
            await writable.write(value);
            await writable.close();
        },

        async remove(key: string): Promise<void> {
            await handle.removeEntry(key);
        },

        async getKeys(includeFolders: boolean = false): Promise<string[]> {
            const keys: string[] = [];
            for await (const [name, entry] of handle) {
                if (entry.kind === "file" || includeFolders) {
                    keys.push(entry.name);
                }
            }
            return keys;
        },

        async reset() {
            for await (const [name, entry] of handle) {
                await handle.removeEntry(entry.name, { recursive: true });
            }
        },
    };
}

function wrapHandleNested(handle: DirectoryWrapper): NestedFileStorage {
    return {
        async hasKey(key: string): Promise<boolean> {
            try {
                await handle.getDirectoryHandle(key);
                return true;
            } catch (error) {
                return false;
            }
        },

        async getStorage(key: string): Promise<FileStorage> {
            const subDirectory = await handle.getDirectoryHandle(key, { create: true });
            return wrapHandle(subDirectory);
        },

        async removeStorage(key: string): Promise<void> {
            await handle.removeEntry(key, { recursive: true });
        },

        async getKeys(): Promise<string[]> {
            const keys: string[] = [];
            for await (const [name, entry] of handle) {
                if (entry.kind === "directory") {
                    keys.push(entry.name);
                }
            }
            return keys;
        },
    };
}

function wrapHandle(handle: DirectoryWrapper): FileStorage {
    return {
        ...wrapHandleFiles(handle),
        folder: wrapHandleNested(handle),
    };
}

async function tryToLoadPointer(pointer: string) {
    let result = await getFileSystemPointer({ pointer });
    if (!result) return;
    let handle = await result?.onUserActivation();
    if (!handle) return;
    return handle as any as DirectoryWrapper;
}