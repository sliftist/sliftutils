import preact from "preact";
import { getFileSystemPointer, storeFileSystemPointer } from "./fileSystemPointer";
import { observable } from "mobx";
import { observer } from "../render-utils/observer";
import { cache, lazy } from "socket-function/src/caching";
import { css, isNode } from "typesafecss";
import { IStorageRaw } from "./IStorage";
import { runInSerial } from "socket-function/src/batching";
import { getFileStorageIndexDB } from "./IndexedDBFileFolderAPI";
import { getRemoteFileStorage, probeRemoteConnection } from "./remoteFileStorage";
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
        // Matches Blob.slice (which the native File object provides), so the browser
        //  implementation works vanilla. End is exclusive, both clamped to the file size.
        slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
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

// ---- remote (server) storage config ----
// Instead of a local folder, the user can point at a remoteFileServer.js instance (URL + password).
// When configured, getFileStorageNested2 serves everything from that server. Persisted in localStorage.
type RemoteConfig = { url: string; password: string };
function remoteConfigKey() { return getFileAPIKey() + ":remote"; }
function loadRemoteConfig(): RemoteConfig | undefined {
    try {
        const s = localStorage.getItem(remoteConfigKey());
        if (!s) return undefined;
        const c = JSON.parse(s);
        if (c && typeof c.url === "string" && typeof c.password === "string") return c;
    } catch { /* ignore */ }
    return undefined;
}
function saveRemoteConfig(c: RemoteConfig) { localStorage.setItem(remoteConfigKey(), JSON.stringify(c)); }

// One shared factory (and therefore one shared range cache) per remote config.
let remoteFactory: { key: string; factory: ReturnType<typeof getRemoteFileStorage> } | undefined;
function getRemoteFactory(remote: RemoteConfig) {
    const key = remote.url + "\0" + remote.password;
    if (!remoteFactory || remoteFactory.key !== key) {
        remoteFactory = { key, factory: getRemoteFileStorage(remote.url, remote.password) };
    }
    return remoteFactory.factory;
}

@observer
class DirectoryPrompter extends preact.Component {
    render() {
        if (!displayData.ui) return undefined;
        return (
            <div className={
                css.position("fixed").pos(0, 0).size("100vw", "100vh")
                    .zIndex(2147483647)
                    .background("white")
                    .center
                    .fontSize(40)
            }>
                {displayData.ui}
            </div>
        );
    }
}

// "Connect to a server" option for the directory prompt: collapses to a button, expands to URL +
// password fields. On connect it validates the credentials against the server, persists the config, and
// reloads so getFileStorageNested2 picks up the remote storage.
@observer
class ServerConnectForm extends preact.Component {
    private obs = observable({ expanded: false, url: "", password: "", error: "", connecting: false, needsCert: false, showPassword: false });
    private cleanUrl() { return this.obs.url.trim().replace(/\/+$/, ""); }
    private connect = async () => {
        const s = this.obs;
        s.error = "";
        s.needsCert = false;
        s.connecting = true;
        try {
            const url = this.cleanUrl();
            if (!url) { s.error = "Enter a server URL"; return; }
            const result = await probeRemoteConnection(url, s.password.trim());
            if (result.status === "ok") {
                saveRemoteConfig({ url, password: s.password.trim() });
                window.location.reload();
                return;
            }
            if (result.status === "unauthorized") {
                s.error = "The server rejected that password.";
            } else {
                // Reached nothing back — almost always the self-signed certificate isn't trusted yet.
                s.needsCert = true;
                s.error = "Couldn't reach the server.";
            }
        } catch (e) {
            s.error = "Could not connect: " + ((e as Error).message || String(e));
        } finally {
            s.connecting = false;
        }
    };
    render() {
        const s = this.obs;
        const inputCss = css.fontSize(28).pad2(24, 14).width(560).maxWidth("80vw");
        const btnCss = css.fontSize(32).pad2(60, 30);
        if (!s.expanded) {
            return <button className={btnCss} onClick={() => s.expanded = true}>Connect to a server</button>;
        }
        return (
            <div className={css.vbox(16).center}>
                <input className={inputCss} placeholder="https://host:8787" value={s.url}
                    onInput={e => s.url = (e.target as HTMLInputElement).value} />
                <div className={css.hbox(10).center}>
                    <input className={inputCss} type={s.showPassword ? "text" : "password"} placeholder="password (six words)" value={s.password}
                        onInput={e => s.password = (e.target as HTMLInputElement).value} />
                    <button className={css.fontSize(22).pad2(24, 12)} onClick={() => s.showPassword = !s.showPassword}>
                        {s.showPassword ? "Hide" : "Show"}
                    </button>
                </div>
                {s.error ? <div className={css.fontSize(22).color("red").maxWidth("80vw")}>{s.error}</div> : null}
                {s.needsCert ? (
                    <div className={css.vbox(10).center.fontSize(20).maxWidth(620).maxWidth("80vw").textAlign("center").color("hsl(0, 0%, 25%)")}>
                        <div>This server uses a self-signed certificate, so your browser has to trust it once:</div>
                        <div>1. Open the server in a new tab (button below). &nbsp; 2. Accept the security warning (Advanced → Proceed). &nbsp; 3. Come back and click Retry.</div>
                        <button className={css.fontSize(26).pad2(40, 20)}
                            onClick={() => { const u = this.cleanUrl(); if (u) window.open(u + "/", "_blank"); }}>
                            Open server &amp; accept certificate
                        </button>
                    </div>
                ) : null}
                <div className={css.hbox(16)}>
                    <button className={btnCss} disabled={s.connecting} onClick={this.connect}>
                        {s.connecting ? "Connecting…" : s.needsCert ? "Retry" : "Connect"}
                    </button>
                    <button className={btnCss} onClick={() => { s.expanded = false; s.error = ""; s.needsCert = false; }}>Back</button>
                </div>
            </div>
        );
    }
}

export class NodeJSFileHandleWrapper implements FileWrapper {
    constructor(private filePath: string) {
    }

    async getFile() {
        const stats = await fs.promises.stat(this.filePath);
        const filePath = this.filePath;
        return {
            size: stats.size,
            lastModified: stats.mtimeMs,
            arrayBuffer: async () => {
                const buffer = await fs.promises.readFile(filePath);
                return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
            },
            slice: (start: number, end: number) => ({
                arrayBuffer: async () => {
                    const clampedStart = Math.min(Math.max(start, 0), stats.size);
                    const clampedEnd = Math.min(Math.max(end, clampedStart), stats.size);
                    const length = clampedEnd - clampedStart;
                    const fileHandle = await fs.promises.open(filePath, "r");
                    try {
                        const buffer = Buffer.alloc(length);
                        await fileHandle.read(buffer, 0, length, clampedStart);
                        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
                    } finally {
                        await fileHandle.close();
                    }
                }
            })
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

export class NodeJSDirectoryHandleWrapper implements DirectoryWrapper {
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
            // Tag as ENOENT so readWithRetry treats it as a genuinely-missing file (return undefined now)
            // rather than a transient read failure to retry 6× with backoff — missing files are normal
            // (a concurrent merge deletes a file mid-read), and retrying them is catastrophically slow.
            const err = new Error(`File not found: ${filePath}`) as Error & { code?: string };
            err.code = "ENOENT";
            throw err;
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
// NOTE: If you want to override the location, you can explicitly call getDirectoryHandle.set with your own directory wrapper. Which if your server side can be the Node.js directory handle wrapper, or if your client side it can just be a pointer from tryToLoadPointer/fileSystemPointer.ts.
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
                    let retryReject: (err: Error) => void;
                    let retryPromise = new Promise<boolean>((resolve, reject) => {
                        retryCallback = resolve;
                        retryReject = reject;
                    });
                    displayData.ui = (
                        <div className={css.vbox(20).center}>
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
                            <button
                                className={css.fontSize(40).pad2(80, 40)}
                                onClick={async () => {
                                    console.log("Waiting for user to give permission");
                                    const pickedHandle = await window.showDirectoryPicker();
                                    await pickedHandle.requestPermission({ mode: "readwrite" });
                                    let newStoredId = await storeFileSystemPointer({ mode: "readwrite", handle: pickedHandle });
                                    localStorage.setItem(getFileAPIKey(), newStoredId);
                                    handle = pickedHandle as any;
                                    retryCallback(true);
                                }}
                            >
                                Pick Data Directory
                            </button>
                            <ServerConnectForm />
                            <button
                                className={css.fontSize(40).pad2(80, 40)}
                                onClick={() => {
                                    retryReject(new Error("User dismissed file system access prompt"));
                                }}
                            >
                                Dismiss
                            </button>
                        </div>
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
        let fileReject: (err: Error) => void;
        let promise = new Promise<DirectoryWrapper>((resolve, reject) => {
            fileCallback = resolve;
            fileReject = reject;
        });
        displayData.ui = (
            <div className={css.vbox(20).center}>
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
                <ServerConnectForm />
                <button
                    className={css.fontSize(40).pad2(80, 40)}
                    onClick={() => {
                        fileReject(new Error("User dismissed file system access prompt"));
                    }}
                >
                    Dismiss
                </button>
            </div>
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
// Supports if the user selects the folder that contains the data folder or the data folder directly. If pathStr is an absolute path (and we're in nodejs) we use it directly.
export const getFileStorageNested2 = cache(async function getFileStorage(pathStr: string): Promise<FileStorage> {
    let base: DirectoryWrapper;
    pathStr = pathStr.replaceAll("\\", "/");
    if (!isNode()) {
        const remote = loadRemoteConfig();
        if (remote) return getRemoteFactory(remote)(pathStr);
    }
    if (isNode()) {
        if (path.isAbsolute(pathStr)) {
            return wrapHandle(new NodeJSDirectoryHandleWrapper(pathStr));
        }
        base = new NodeJSDirectoryHandleWrapper(path.resolve("./data/"));
    } else {
        base = await getDirectoryHandle();
        let dirs: string[] = [];
        let alls: string[] = [];
        for await (const [name, entry] of base) {
            if (entry.kind === "directory") {
                dirs.push(name);
            }
            alls.push(name);
        }
        // HACK: If there are enough files, it's almost certainly not a directory that contains collections. It's probably the user's data instead
        if (dirs.includes(".git") || dirs.includes("data") || alls.length > 100) {
            base = await base.getDirectoryHandle("data", { create: true });
        }
    }
    for (let part of pathStr.split("/")) {
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
    try { localStorage.removeItem(remoteConfigKey()); } catch { /* ignore */ }
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

// A file that genuinely does not exist. We must NOT retry these, otherwise reading many missing
// files (a common pattern) gets catastrophically slow.
function isMissingError(error: unknown): boolean {
    let name = (error as { name?: string })?.name;
    let code = (error as { code?: string })?.code;
    return name === "NotFoundError" || code === "ENOENT";
}

const MAX_READ_RETRIES = 6;

// The browser File System Access API can transiently fail reads under heavy load (it appears to
// throttle when a page issues many reads at once). Those failures surface as errors OTHER than
// "not found", so we retry them with backoff. A real missing file (NotFoundError / ENOENT) returns
// undefined immediately with no retry.
async function readWithRetry<T>(label: string, key: string, read: () => Promise<T>): Promise<T | undefined> {
    let backoff = 25;
    for (let attempt = 0; ; attempt++) {
        try {
            return await read();
        } catch (error) {
            if (isMissingError(error)) return undefined;
            let name = (error as { name?: string })?.name || "Error";
            let message = (error as { message?: string })?.message || String(error);
            if (attempt >= MAX_READ_RETRIES) {
                console.warn(`${label} gave up on ${JSON.stringify(key)} after ${attempt} retries (${name}): ${message.slice(0, 200)}`);
                return undefined;
            }
            console.warn(`${label} retrying ${JSON.stringify(key)} (attempt ${attempt + 1}, ${name}): ${message.slice(0, 200)}`);
            await new Promise(resolve => setTimeout(resolve, backoff));
            backoff = Math.min(backoff * 2, 1000);
        }
    }
}

function wrapHandleFiles(handle: DirectoryWrapper): IStorageRaw {
    return {
        async getInfo(key: string) {
            return readWithRetry("getInfo", key, async () => {
                const file = await handle.getFileHandle(key);
                const fileContent = await file.getFile();
                return {
                    size: fileContent.size,
                    lastModified: fileContent.lastModified,
                };
            });
        },
        async get(key: string): Promise<Buffer | undefined> {
            return readWithRetry("get", key, async () => {
                const file = await handle.getFileHandle(key);
                const fileContent = await file.getFile();
                const arrayBuffer = await fileContent.arrayBuffer();
                // Under load the FS Access API can resolve with a truncated buffer and no error.
                //  Treat a short read as transient so readWithRetry retries it.
                if (arrayBuffer.byteLength !== fileContent.size) {
                    throw Object.assign(new Error(`Short read: got ${arrayBuffer.byteLength} of ${fileContent.size} bytes`), { name: "ShortReadError" });
                }
                return Buffer.from(arrayBuffer);
            });
        },

        async getRange(key: string, config: { start: number; end: number }): Promise<Buffer | undefined> {
            return readWithRetry("getRange", key, async () => {
                const file = await handle.getFileHandle(key);
                const fileContent = await file.getFile();
                const clampedStart = Math.min(Math.max(config.start, 0), fileContent.size);
                const clampedEnd = Math.min(Math.max(config.end, clampedStart), fileContent.size);
                const arrayBuffer = await fileContent.slice(config.start, config.end).arrayBuffer();
                if (arrayBuffer.byteLength !== clampedEnd - clampedStart) {
                    throw Object.assign(new Error(`Short range read: got ${arrayBuffer.byteLength} of ${clampedEnd - clampedStart} bytes`), { name: "ShortReadError" });
                }
                return Buffer.from(arrayBuffer);
            });
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
            try {
                for await (const [name, entry] of handle) {
                    if (entry.kind === "file" || includeFolders) {
                        keys.push(entry.name);
                    }
                }
            } catch (error) {
                let name = (error as { name?: string })?.name || "Error";
                let message = (error as { message?: string })?.message || String(error);
                // A failure mid-iteration would silently truncate the listing, so surface it loudly.
                console.error(`getKeys directory iteration failed after ${keys.length} entries (${name}): ${message.slice(0, 300)}`);
                throw error;
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

export function wrapHandle(handle: DirectoryWrapper): FileStorage {
    return {
        ...wrapHandleFiles(handle),
        folder: wrapHandleNested(handle),
    };
}

export async function tryToLoadPointer(pointer: string) {
    let result = await getFileSystemPointer({ pointer });
    if (!result) return;
    let handle = await result?.onUserActivation();
    if (!handle) return;
    return handle as any as DirectoryWrapper;
}