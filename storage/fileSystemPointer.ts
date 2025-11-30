import { lazy } from "socket-function/src/caching";
import { nextId } from "socket-function/src/misc";

const objectStoreName = "fileSystemPointerDB";
const db = lazy(async () => {
    let db = indexedDB.open("fileSystemPointerDB_f298e962-bd8a-46b9-8098-25db633f4ed3", 1);
    db.addEventListener("upgradeneeded", () => {
        db.result.createObjectStore(objectStoreName, {});
    });
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

export async function getFileSystemPointer(config: {
    pointer: FileSystemPointer;
}): Promise<{
    // NOTE: We have to call requestPermission, so... user activation is required (as in,
    //  this need to be called inside of a button).
    // IMPORTANT! In some circumstances user activation is not required (with multiple tabs,
    //      and potentially with https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api),
    //      so... trying to call onUserActivation immmediately is a good idea (although it might throw).
    onUserActivation(modeOverride?: "read" | "readwrite"): Promise<FileSystemFileHandle | FileSystemDirectoryHandle>
} | undefined
> {
    const handle = await read(config.pointer);
    if (!handle) return;
    let mode = config.pointer.split("_").at(-1);
    return {
        async onUserActivation(modeOverride) {
            let testMode = await (handle as any).queryPermission({ mode: mode });
            if (testMode !== mode) {
                await (handle as any).requestPermission({ mode: modeOverride ?? mode });
            }
            return handle;
        }
    };
}