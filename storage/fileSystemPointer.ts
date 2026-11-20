import { lazy } from "socket-function/src/caching";
import { nextId } from "socket-function/src/misc";

const objectStoreName = "fileSystemPointerDB";
const db = lazy(async () => {
    let db = indexedDB.open("fileSystemPointerDB_f298e962-bd8a-46b9-8098-25db633f4ed3", 1);
    db.addEventListener("upgradeneeded", () => {
        db.result.createObjectStore(objectStoreName, {});
    });
    // This line might just never come back: it only waits for success, so an open that errors or is blocked waits forever.
    await new Promise(resolve => db.addEventListener("success", resolve));
    return db.result;
});
async function getTransaction() {
    let database = await db();
    if (!database) return undefined;
    return database.transaction(objectStoreName, "readwrite").objectStore(objectStoreName);
}
async function write(key: string, value: FileSystemFileHandle | FileSystemDirectoryHandle) {
    let transaction = await getTransaction();
    if (!transaction) return;
    let req = transaction.put(value, key);
    await new Promise((resolve, reject) => {
        req.addEventListener("success", resolve);
        req.addEventListener("error", reject);
    });
}
async function read(key: string): Promise<FileSystemFileHandle | FileSystemDirectoryHandle | undefined> {
    let transaction = await getTransaction();
    if (!transaction) return;
    let req = transaction.get(key);
    await new Promise((resolve, reject) => {
        req.addEventListener("success", resolve);
        req.addEventListener("error", reject);
    });
    return req.result;
}

export type FileSystemPointer = string;
export async function storeFileSystemPointer(config: {
    mode: "read" | "readwrite";
    handle: FileSystemFileHandle | FileSystemDirectoryHandle;
}): Promise<FileSystemPointer> {
    // This line might wait for the user to confirm it, or it might just never come back.
    await (config.handle as any).requestPermission({ mode: config.mode });
    let key = nextId() + "_" + config.mode;
    await write(key, config.handle);
    return key;
}
export async function deleteFileSystemPointer(pointer: FileSystemPointer) {
    let transaction = await getTransaction();
    if (!transaction) return;
    let req = transaction.delete(pointer);
    await new Promise((resolve, reject) => {
        req.addEventListener("success", resolve);
        req.addEventListener("error", reject);
    });
}

// Enumerates every stored pointer handle whose permission is already granted for `mode`, newest first (pointer keys start with Date.now(), which sorts lexicographically). Callable from a Web Worker — unlike getFileSystemPointer's onUserActivation flow, this only uses queryPermission, which does NOT require user activation.
export async function findGrantedPointerHandle(mode: "read" | "readwrite"): Promise<FileSystemDirectoryHandle | undefined> {
    let database = await db();
    if (!database) return undefined;
    let store = database.transaction(objectStoreName, "readonly").objectStore(objectStoreName);
    let keysReq = store.getAllKeys();
    let valuesReq = store.getAll();
    await new Promise((resolve, reject) => {
        keysReq.addEventListener("success", resolve);
        keysReq.addEventListener("error", reject);
    });
    await new Promise((resolve, reject) => {
        valuesReq.addEventListener("success", resolve);
        valuesReq.addEventListener("error", reject);
    });
    let keys = keysReq.result as string[];
    let values = valuesReq.result as (FileSystemFileHandle | FileSystemDirectoryHandle)[];
    let entries = keys.map((key, i) => ({ key, value: values[i], time: +key.split("_")[0] || 0 }))
        .sort((a, b) => b.time - a.time);
    for (let entry of entries) {
        if (entry.value.kind !== "directory") continue;
        // This line might just never come back.
        let state = await (entry.value as any).queryPermission({ mode });
        if (state === "granted") return entry.value;
    }
    return undefined;
}

export async function getFileSystemPointer(config: {
    pointer: FileSystemPointer;
}): Promise<{
    // NOTE: We have to call requestPermission, so... user activation is required (as in,
    //  this need to be called inside of a button).
    // IMPORTANT! In some circumstances user activation is not required (with multiple tabs, and potentially with https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api), so... trying to call onUserActivation immmediately is a good idea (although it might throw).
    onUserActivation(modeOverride?: "read" | "readwrite"): Promise<FileSystemFileHandle | FileSystemDirectoryHandle>
} | undefined
> {
    console.info(`[fileSystemPointer] reading pointer ${config.pointer} from IndexedDB`);
    const handle = await read(config.pointer);
    console.info(`[fileSystemPointer] pointer ${config.pointer} read: ${handle && `${handle.kind} ${handle.name}` || "not stored"}`);
    if (!handle) return;
    let mode = config.pointer.split("_").at(-1);
    return {
        async onUserActivation(modeOverride) {
            const requestMode = modeOverride ?? mode;
            let testMode: unknown = "not queried";
            if (!navigator.userActivation?.isActive) {
                console.info(`[fileSystemPointer] ${config.pointer} (${handle.kind} ${handle.name}): querying ${mode} permission`);
                try {
                    // This line might just never come back.
                    testMode = await (handle as any).queryPermission({ mode: mode });
                } catch (err) {
                    console.info(`[fileSystemPointer] ${config.pointer} (${handle.name}): queryPermission ${mode} threw:`, (err as Error)?.stack ?? err);
                    throw err;
                }
                console.info(`[fileSystemPointer] ${config.pointer} (${handle.name}): queryPermission ${mode} → ${testMode}`);
            }
            if (testMode !== "granted") {
                const requestedAt = Date.now();
                console.info(`[file access] ${handle.name}: before requestPermission ${requestMode}`);
                let requested: unknown;
                try {
                    // This line might wait for the user to confirm it, or it might just never come back.
                    requested = await (handle as any).requestPermission({ mode: requestMode });
                } catch (err) {
                    console.info(`[file access] ${handle.name}: after requestPermission ${requestMode}, threw after ${Date.now() - requestedAt}ms:`, (err as Error)?.stack ?? err);
                    throw err;
                }
                console.info(`[file access] ${handle.name}: after requestPermission ${requestMode}, ${requested} after ${Date.now() - requestedAt}ms`);
                if (requested !== "granted") throw new Error(`Expected ${requestMode} permission on ${handle.kind} ${handle.name} (pointer ${config.pointer}) to be granted, was ${requested}`);
            }
            return handle;
        }
    };
}