import preact from "preact";
import { findGrantedPointerHandle, getFileSystemPointer, storeFileSystemPointer } from "./fileSystemPointer";
import { observable } from "mobx";
import { observer } from "../render-utils/observer";
import { cache, lazy } from "socket-function/src/caching";
import { css, isNode } from "typesafecss";
import { IStorageRaw } from "./IStorage";
import { runInSerial } from "socket-function/src/batching";
import { getFileStorageIndexDB } from "./IndexedDBFileFolderAPI";
import { getRemoteDirectoryHandle, testRemoteConnection, RemoteOptions } from "./remoteFileStorage";
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

// How often a worker rechecks the pointer IndexedDB for a granted handle when none is available yet.
const WORKER_POLL_INTERVAL_MS = 60 * 1000;

// These mirror the subset of the native FileSystemFileHandle / FileSystemDirectoryHandle API we use, so the native browser handles, the Node handles, and the remote handles are all interchangeable — and code written against the native handle (e.g. a recursive walk over `handle.entries()`) works on any of them. kind/name and entries() are part of that contract.
export type FileWrapper = {
    readonly kind: "file";
    readonly name: string;
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
    // Returns a URL for the file's bytes, usable in <video>/<img>/fetch. Optional — the native browser FileSystemFileHandle has no such method, so prefer the getFileURL() helper, which falls back to a blob: URL via createObjectURL for native handles. Always release it with disposeFileURL when done.
    getURL?(): Promise<string>;
};
export type DirectoryWrapper = {
    readonly kind: "directory";
    readonly name: string;
    // Full path from the storage root, for diagnostics/logging (the native handle doesn't expose paths, so it's optional). e.g. "bulkDatabases2/myCollection".
    readonly fullPath?: string;
    // True when this storage is served over the network (a remote server) rather than a local disk, so callers can adapt for the higher latency/cost (local/native handles leave it undefined = false).
    readonly isRemote?: boolean;
    removeEntry(key: string, options?: { recursive?: boolean }): Promise<void>;
    getFileHandle(key: string, options?: { create?: boolean }): Promise<FileWrapper>;
    getDirectoryHandle(key: string, options?: { create?: boolean }): Promise<DirectoryWrapper>;
    // Each entry IS a handle (file or directory), so a recursive walk keeps working at every level.
    entries(): AsyncIterableIterator<[string, FileWrapper | DirectoryWrapper]>;
    [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileWrapper | DirectoryWrapper]>;
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

// A directory handle to serve as the storage root instead of resolving one via
// the picker / stored-pointer / remote flow. Set this in a context that can't run
// the interactive resolution — most importantly a Web Worker, which has no DOM to
// prompt with and no localStorage pointer. The owning window resolves the handle
// (with its permission grant) and postMessages it in; the worker calls this before
// touching any storage. When set, getDirectoryHandle returns it directly and skips
// every DOM / localStorage branch below.
let storageRootOverride: FileSystemDirectoryHandle | undefined;
export function setStorageRootOverride(handle: FileSystemDirectoryHandle | undefined): void {
    storageRootOverride = handle;
}

// ---- remote (server) storage config ----
// Instead of a local folder, the user can point at a remoteFileServer.js instance (URL + password). When configured, getFileStorageNested2 serves everything from that server. Persisted in localStorage.
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

// The server is always HTTPS on the filehoster's default port, so the user only needs to type the host (e.g. "65.109.93.113"). We strip any scheme/path they include and default the port if omitted.
const DEFAULT_REMOTE_PORT = 8787; // matches remoteFileServer.js's default
function normalizeServerUrl(raw: string): string {
    let s = raw.trim().replace(/^\w+:\/\//, "").replace(/\/.*$/, "");
    if (!s) return "";
    if (!/:\d+$/.test(s)) s += ":" + DEFAULT_REMOTE_PORT;
    return "https://" + s;
}

// One shared remote DirectoryWrapper (and therefore one shared range cache) per remote config.
let remoteHandle: { key: string; handle: DirectoryWrapper } | undefined;
function getRemoteHandle(remote: RemoteConfig): DirectoryWrapper {
    const key = remote.url + "\0" + remote.password;
    if (!remoteHandle || remoteHandle.key !== key) {
        remoteHandle = { key, handle: getRemoteDirectoryHandle(remote.url, remote.password) };
    }
    return remoteHandle.handle;
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

// "Connect to a server" option for the directory prompt: collapses to a button, expands to address + password fields. On connect it ACTUALLY connects (testRemoteConnection); only on success does it persist the config and call onConnected, so the caller (getDirectoryHandle) resolves with a working remote handle. Failures are shown to the user (and logged, without the password), never swallowed. `initial` pre-fills + expands the form (used to retry a remembered server that stopped working).
@observer
class ServerConnectForm extends preact.Component<{ onConnected: (config: RemoteConfig) => void; initial?: RemoteConfig }> {
    private obs = observable({
        expanded: !!this.props.initial,
        url: this.props.initial?.url || "",
        password: this.props.initial?.password || "",
        error: "", connecting: false, needsCert: false, showPassword: false,
    });
    private cleanUrl() { return normalizeServerUrl(this.obs.url); }
    private connect = async () => {
        const s = this.obs;
        s.error = "";
        s.needsCert = false;
        s.connecting = true;
        try {
            const url = this.cleanUrl();
            if (!url) { s.error = "Enter a server address."; return; }
            const result = await testRemoteConnection(url, s.password.trim());
            if (result.status === "ok") {
                const config: RemoteConfig = { url, password: s.password.trim() };
                saveRemoteConfig(config);             // remember for next session
                this.props.onConnected(config);       // hand the verified server back to getDirectoryHandle
                return;
            }
            if (result.status === "unauthorized") {
                s.error = "The server rejected that password.";
                console.error("Remote connect: unauthorized for", url);
            } else {
                // Got nothing back — usually the self-signed certificate isn't trusted yet, but show the actual error too so a wrong address / down server / CORS issue is diagnosable.
                s.needsCert = true;
                s.error = "Couldn't reach the server: " + result.error;
                console.error("Remote connect: unreachable", url, "-", result.error);
            }
        } catch (e) {
            s.error = "Connection error: " + ((e as Error).message || String(e));
            console.error("Remote connect threw:", e);
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
                <input className={inputCss} placeholder="server address (e.g. 65.109.93.113, or host:port)" value={s.url}
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
    readonly kind = "file" as const;
    get name() { return path.basename(this.filePath); }

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

    async getURL() {
        return "file://" + path.resolve(this.filePath);
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
    readonly kind = "directory" as const;
    get name() { return path.basename(this.rootPath); }
    get fullPath() { return this.rootPath; }
    entries() { return this[Symbol.asyncIterator](); }

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
            // Tag as ENOENT so readWithRetry treats it as a genuinely-missing file (return undefined now) rather than a transient read failure to retry 6× with backoff — missing files are normal (a concurrent merge deletes a file mid-read), and retrying them is catastrophically slow.
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

    async *[Symbol.asyncIterator](): AsyncIterableIterator<[string, FileWrapper | DirectoryWrapper]> {
        // Ensure directory exists
        await fs.promises.mkdir(this.rootPath, { recursive: true });

        const entries = await fs.promises.readdir(this.rootPath, { withFileTypes: true });

        for (const entry of entries) {
            const childPath = path.join(this.rootPath, entry.name);
            if (entry.isFile()) {
                yield [entry.name, new NodeJSFileHandleWrapper(childPath)];
            } else if (entry.isDirectory()) {
                yield [entry.name, new NodeJSDirectoryHandleWrapper(childPath)];
            }
        }
    }
}


// When set, getDirectoryHandle skips every prompt + remote check and serves from the browser's Origin Private File System (OPFS). One named subfolder is "current" per fileAPIKey; pickPrivateFolder / resetStorageLocation switch which one. Set this in app startup BEFORE the first getDirectoryHandle.
let opfsEnabled = false;
const OPFS_FOLDERS_DIR = "folders";
const OPFS_DEFAULT_FOLDER = "default";
function opfsCurrentKey() { return getFileAPIKey() + ":opfs:current"; }
function getCurrentOpfsFolder(): string {
    return localStorage.getItem(opfsCurrentKey()) || OPFS_DEFAULT_FOLDER;
}
function setCurrentOpfsFolder(name: string): void {
    localStorage.setItem(opfsCurrentKey(), name);
}

// Switches getDirectoryHandle to the Origin Private File System. No directory picker, no permission prompt, no remote server check. Persists nothing — call on every app start before reading storage.
export function usePrivateFileSystem(): void {
    opfsEnabled = true;
}

// Whether the OPFS branch is in effect (so other callers can adapt — e.g. skip the "find data subdir" hack in getFileStorageNested2 since OPFS is always a clean root we own end-to-end).
export function isPrivateFileSystemActive(): boolean {
    return opfsEnabled;
}

async function getOpfsFoldersDir(): Promise<FileSystemDirectoryHandle> {
    if (!navigator.storage?.getDirectory) {
        throw new Error("Private File System Access API not supported in this browser");
    }
    if (location.protocol === "file:") {
        throw new Error("Private File System API is disallowed in file:// locations. Host on an actual origin.");
    }
    const root = await navigator.storage.getDirectory();
    const keyed = await root.getDirectoryHandle(getFileAPIKey(), { create: true });
    return await keyed.getDirectoryHandle(OPFS_FOLDERS_DIR, { create: true });
}

async function getCurrentOpfsHandle(): Promise<DirectoryWrapper> {
    const folders = await getOpfsFoldersDir();
    const folder = await folders.getDirectoryHandle(getCurrentOpfsFolder(), { create: true });
    return folder as unknown as DirectoryWrapper;
}

// All previously-used OPFS subfolders under this fileAPIKey, sorted alphabetically (timestamp-named auto-generated folders therefore sort chronologically). Use this to surface a list, then call pickPrivateFolder(name) to switch.
export async function listPrivateFolders(): Promise<string[]> {
    if (!navigator.storage?.getDirectory) return [];
    let folders: FileSystemDirectoryHandle;
    try { folders = await getOpfsFoldersDir(); } catch { return []; }
    const names: string[] = [];
    for await (const [name, handle] of (folders as unknown as AsyncIterable<[string, { kind: string }]>)) {
        if (handle.kind === "directory") names.push(name);
    }
    return names.sort();
}

// Switch to a specific OPFS subfolder and reload so getDirectoryHandle re-resolves to it. The folder is created if it doesn't exist yet.
export function pickPrivateFolder(name: string): void {
    setCurrentOpfsFolder(name);
    window.location.reload();
}

// Returns the directory handle to use — local (Node / picked folder) OR a remote server, both as the same DirectoryWrapper, so callers don't know or care which it is. A remembered server is VERIFIED (we actually connect) before use; if it no longer works we re-prompt, just like a local folder whose permission was lost. Blocks until ready (or the user dismisses, which rejects).
export const getDirectoryHandle = lazy(async function getDirectoryHandle(): Promise<DirectoryWrapper> {
    // An injected root (e.g. a Web Worker handed the handle by its owning window)
    // short-circuits the whole interactive resolution — no picker, no DOM, no
    // localStorage. Must come first so a worker never reaches the branches below.
    if (storageRootOverride) {
        return storageRootOverride as unknown as DirectoryWrapper;
    }
    // A worker can't show the picker (no DOM / no user activation) and can't read localStorage, but it CAN open the pointer IndexedDB the main-thread picker persists to. Poll it for a handle whose permission is already granted; the owning window may also postMessage a handle in mid-poll (checked each iteration). This has to come before the isNode branch: typesafecss's isNode() returns true in workers (window is undefined), so a worker would otherwise fall into the Node branch and try to use fs/path.
    if ("WorkerGlobalScope" in globalThis) {
        while (true) {
            if (storageRootOverride) return storageRootOverride as unknown as DirectoryWrapper;
            let handle = await findGrantedPointerHandle("readwrite");
            if (handle) return handle as unknown as DirectoryWrapper;
            await new Promise(resolve => setTimeout(resolve, WORKER_POLL_INTERVAL_MS));
        }
    }
    if (isNode()) {
        return new NodeJSDirectoryHandleWrapper(path.resolve("./data/"));
    }
    if (opfsEnabled) {
        return getCurrentOpfsHandle();
    }

    // A server connected in a previous session: only reuse it if it still actually works.
    const savedRemote = loadRemoteConfig();
    if (savedRemote) {
        const result = await testRemoteConnection(savedRemote.url, savedRemote.password);
        if (result.status === "ok") return getRemoteHandle(savedRemote);
        console.warn(`Saved remote server didn't connect (${result.status})${result.status === "unreachable" ? ": " + result.error : ""} — re-prompting.`);
    }

    let root = document.createElement("div");
    document.body.appendChild(root);
    preact.render(<DirectoryPrompter />, root);
    try {
        let resolveHandle!: (h: DirectoryWrapper) => void;
        let rejectHandle!: (e: Error) => void;
        const promise = new Promise<DirectoryWrapper>((res, rej) => { resolveHandle = res; rejectHandle = rej; });

        const pickLocal = async () => {
            try {
                const handle = await window.showDirectoryPicker();
                await handle.requestPermission({ mode: "readwrite" });
                const storedId = await storeFileSystemPointer({ mode: "readwrite", handle });
                localStorage.setItem(getFileAPIKey(), storedId);
                resolveHandle(handle as any);
            } catch (e) {
                console.error("Directory pick failed/cancelled:", e); // stay on the prompt
            }
        };
        const onConnected = (config: RemoteConfig) => { saveRemoteConfig(config); resolveHandle(getRemoteHandle(config)); };
        // The three options, rendered fresh each time. If a saved server just failed, pre-fill + expand the connect form so the user can retry or fix it.
        const renderOptions = () => (
            <>
                <button className={css.fontSize(40).pad2(80, 40)} onClick={pickLocal}>Pick Data Directory</button>
                <ServerConnectForm onConnected={onConnected} initial={savedRemote} />
                <button className={css.fontSize(40).pad2(80, 40)}
                    onClick={() => rejectHandle(new Error("User dismissed file system access prompt"))}>Dismiss</button>
            </>
        );

        // A previously-picked local folder: try to restore it (may need a click). Skipped when a saved server failed — that user wants the server, so go straight to the (pre-filled) prompt.
        const storedId = !savedRemote && localStorage.getItem(getFileAPIKey());
        if (storedId) {
            let doneLoad = false;
            setTimeout(() => { if (!doneLoad) displayData.ui = "Click anywhere to allow file system access"; }, 500);
            try {
                const handle = await tryToLoadPointer(storedId);
                doneLoad = true;
                if (handle) return handle;
            } catch (e) {
                doneLoad = true;
                console.error(e);
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.includes("user activation") || msg.includes("User activation")) {
                    displayData.ui = (
                        <div className={css.vbox(20).center}>
                            <button className={css.fontSize(40).pad2(80, 40)} onClick={async () => {
                                displayData.ui = "Loading...";
                                try {
                                    const h = await tryToLoadPointer(storedId);
                                    if (h) { resolveHandle(h); return; }
                                } catch (retryError) { console.error("Retry failed:", retryError); }
                                displayData.ui = <div className={css.vbox(20).center}>{renderOptions()}</div>;
                            }}>Click to restore file system access</button>
                            {renderOptions()}
                        </div>
                    );
                    return await promise;
                }
            }
        }
        displayData.ui = <div className={css.vbox(20).center}>{renderOptions()}</div>;
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
    if (isNode()) {
        if (path.isAbsolute(pathStr)) {
            return wrapHandle(new NodeJSDirectoryHandleWrapper(pathStr));
        }
        base = new NodeJSDirectoryHandleWrapper(path.resolve("./data/"));
    } else {
        base = await getDirectoryHandle();
        // Skip the "find data subdir" hack under OPFS — that's for picked directories where the user might have selected a folder with unrelated files; OPFS is a clean root we own end-to-end.
        if (!opfsEnabled) {
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
    if (opfsEnabled) {
        // Don't delete previous folder — listPrivateFolders / pickPrivateFolder still need it. Just point "current" at a fresh timestamp-named one so the next reload starts clean.
        setCurrentOpfsFolder(new Date().toISOString().replace(/[:.]/g, "-"));
        window.location.reload();
        return;
    }
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
    // Mirrors DirectoryWrapper.isRemote: true when this storage is served over the network. Lets callers (e.g. BulkDatabase2, which skips automatic compaction over the network by default) adapt.
    isRemote?: boolean;
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

// A file that genuinely does not exist. We must NOT retry these, otherwise reading many missing files (a common pattern) gets catastrophically slow.
function isMissingError(error: unknown): boolean {
    let name = (error as { name?: string })?.name;
    let code = (error as { code?: string })?.code;
    return name === "NotFoundError" || code === "ENOENT";
}

const MAX_READ_RETRIES = 6;

// The browser File System Access API can transiently fail reads under heavy load (it appears to throttle when a page issues many reads at once). Those failures surface as errors OTHER than "not found", so we retry them with backoff. A real missing file (NotFoundError / ENOENT) returns undefined immediately with no retry.
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
    // Log the full path (root + filename) when available, so a failing file is identifiable.
    const pathOf = (key: string) => handle.fullPath ? handle.fullPath + "/" + key : key;
    return {
        async getInfo(key: string) {
            return readWithRetry("getInfo", pathOf(key), async () => {
                const file = await handle.getFileHandle(key);
                const fileContent = await file.getFile();
                return {
                    size: fileContent.size,
                    lastModified: fileContent.lastModified,
                };
            });
        },
        async get(key: string): Promise<Buffer | undefined> {
            return readWithRetry("get", pathOf(key), async () => {
                const file = await handle.getFileHandle(key);
                const fileContent = await file.getFile();
                const arrayBuffer = await fileContent.arrayBuffer();
                // Under load the FS Access API can resolve with a truncated buffer and no error. Treat a short read as transient so readWithRetry retries it.
                if (arrayBuffer.byteLength !== fileContent.size) {
                    throw Object.assign(new Error(`Short read: got ${arrayBuffer.byteLength} of ${fileContent.size} bytes`), { name: "ShortReadError" });
                }
                return Buffer.from(arrayBuffer);
            });
        },

        async getRange(key: string, config: { start: number; end: number }): Promise<Buffer | undefined> {
            return readWithRetry("getRange", pathOf(key), async () => {
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
                // NOTE: Interesting point. Chrome doesn't optimize this to be an append, and instead rewrites the entire file.
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
        isRemote: handle.isRemote,
    };
}

// Returns a URL for a file's bytes, ready to drop into <video>/<img>/fetch. A native (local) file becomes an in-memory blob: URL; a remote file becomes an https URL into the server's range-capable /media endpoint (auth token in the query, since a media element can't send headers). Both support HTTP range / seeking. ALWAYS hand the result to disposeFileURL when finished — for blob: URLs that frees memory.
export async function getFileURL(file: FileWrapper): Promise<string> {
    if (file.getURL) return file.getURL();
    // Native FileSystemFileHandle (or any Blob-backed file): a blob: URL over the File itself.
    const f = await file.getFile();
    return URL.createObjectURL(f as unknown as Blob);
}

// Releases a URL from getFileURL. blob: URLs leak until the document is gone unless revoked; https/file: URLs need no cleanup, so this is a no-op for them.
export function disposeFileURL(url: string): void {
    if (url.startsWith("blob:")) {
        try { URL.revokeObjectURL(url); } catch { /* not in a browser, or already revoked */ }
    }
}

// A StorageFactory backed by a remote server (path -> FileStorage), for code that injects its own storage into BulkDatabase2 rather than going through the directory prompt.
export function getRemoteFileStorageFactory(url: string, password: string, options?: RemoteOptions): (pathStr: string) => Promise<FileStorage> {
    const root = getRemoteDirectoryHandle(url, password, options);
    return async (pathStr: string) => {
        let base: DirectoryWrapper = root;
        for (const part of pathStr.replaceAll("\\", "/").split("/")) {
            if (!part) continue;
            base = await base.getDirectoryHandle(part, { create: true });
        }
        return wrapHandle(base);
    };
}

export async function tryToLoadPointer(pointer: string) {
    let result = await getFileSystemPointer({ pointer });
    if (!result) return;
    let handle = await result?.onUserActivation();
    if (!handle) return;
    return handle as any as DirectoryWrapper;
}