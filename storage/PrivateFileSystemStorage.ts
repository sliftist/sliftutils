import { IStorageRaw } from "./IStorage";

export class PrivateFileSystemStorage implements IStorageRaw {
    private rootHandle: FileSystemDirectoryHandle | undefined;

    constructor(private path: string) { }

    private async ensureInitialized(): Promise<FileSystemDirectoryHandle> {
        if (!this.rootHandle) {
            if (!navigator.storage?.getDirectory) {
                throw new Error("Private File System Access API not supported in this browser");
            }
            if (location.protocol === "file:") {
                throw new Error(`Private File System API is disallowed in file:// type locations. Either use the File System API (the use gives you access to their file system), or host on an actual domain`);
            }
            this.rootHandle = await navigator.storage.getDirectory();
        }
        return this.rootHandle;
    }

    private async directoryExists(): Promise<boolean> {
        const root = await this.ensureInitialized();
        try {

            if (!this.path || this.path === "" || this.path === "/") {
                return true; // Root always exists
            }

            const pathParts = this.path.split("/").filter(part => part.length > 0);
            let currentHandle = root;

            for (const part of pathParts) {
                try {
                    currentHandle = await currentHandle.getDirectoryHandle(part);
                } catch (error) {
                    return false;
                }
            }

            return true;
        } catch (error) {
            return false;
        }
    }

    private async getDirectoryHandle(createPath: boolean = true): Promise<FileSystemDirectoryHandle> {
        const root = await this.ensureInitialized();

        if (!this.path || this.path === "" || this.path === "/") {
            return root;
        }

        const pathParts = this.path.split("/").filter(part => part.length > 0);
        let currentHandle = root;

        for (const part of pathParts) {
            try {
                currentHandle = await currentHandle.getDirectoryHandle(part, { create: createPath });
            } catch (error) {
                if (!createPath) {
                    throw new Error(`Directory not found: ${this.path}`);
                }
                throw error;
            }
        }

        return currentHandle;
    }

    // Keys may contain "/" (nested paths). OPFS handles reject separators in names, so we
    // walk/create the intermediate directories and return the leaf directory + file name.
    private async resolveKey(key: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
        let dir = await this.getDirectoryHandle(create);
        const parts = key.split("/").filter(part => part.length > 0);
        const name = parts.pop();
        if (!name) {
            throw new Error(`Invalid empty key: ${JSON.stringify(key)}`);
        }
        for (const part of parts) {
            dir = await dir.getDirectoryHandle(part, { create });
        }
        return { dir, name };
    }

    private async getFileHandle(key: string, create: boolean = false): Promise<FileSystemFileHandle | undefined> {
        await this.ensureInitialized();
        if (create) {
            const { dir, name } = await this.resolveKey(key, true);
            return await dir.getFileHandle(name, { create: true });
        }
        try {
            const { dir, name } = await this.resolveKey(key, false);
            return await dir.getFileHandle(name);
        } catch (error) {
            return undefined;
        }
    }

    private async fileExists(key: string): Promise<boolean> {
        return !!(await this.getFileHandle(key, false));
    }

    public async get(key: string): Promise<Buffer | undefined> {
        // Check if file exists first to avoid unnecessary errors
        if (!(await this.fileExists(key))) {
            return undefined;
        }

        try {
            const fileHandle = await this.getFileHandle(key, false);
            if (!fileHandle) {
                return undefined;
            }

            const file = await fileHandle.getFile();
            const arrayBuffer = await file.arrayBuffer();
            return Buffer.from(arrayBuffer);
        } catch (error) {
            console.warn(`Error reading file ${key}:`, error);
            return undefined;
        }
    }

    public async getRange(key: string, config: { start: number; end: number }): Promise<Buffer | undefined> {
        const fileHandle = await this.getFileHandle(key, false);
        if (!fileHandle) {
            return undefined;
        }

        const file = await fileHandle.getFile();
        const arrayBuffer = await file.slice(config.start, config.end).arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    public async set(key: string, value: Buffer): Promise<void> {
        await this.ensureInitialized();
        const { dir, name } = await this.resolveKey(key, true);
        const fileHandle = await dir.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(value);
        await writable.close();
    }

    public async append(key: string, value: Buffer): Promise<void> {
        const existingContent = await this.get(key);
        let newContent: Buffer;
        if (existingContent) {
            newContent = Buffer.concat([existingContent, value]);
        } else {
            newContent = value;
        }
        await this.set(key, newContent);
    }

    public async remove(key: string): Promise<void> {
        // Check if file exists first to avoid unnecessary errors
        if (!(await this.fileExists(key))) {
            return; // File doesn't exist, nothing to remove
        }

        const { dir, name } = await this.resolveKey(key, false);
        await dir.removeEntry(name);
    }

    public async getKeys(): Promise<string[]> {
        // Check if directory exists first to avoid unnecessary errors
        if (!(await this.directoryExists())) {
            return [];
        }

        const dirHandle = await this.getDirectoryHandle(false);
        const keys: string[] = [];
        const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
            // Use the async iterator protocol for FileSystemDirectoryHandle
            for await (const [name, handle] of (dir as any).entries()) {
                if (handle.kind === "file") {
                    keys.push(prefix + name);
                } else if (handle.kind === "directory") {
                    await walk(handle, prefix + name + "/");
                }
            }
        };
        await walk(dirHandle, "");
        return keys.sort();
    }
    public async getInfo(key: string): Promise<undefined | {
        size: number;
        lastModified: number;
    }> {
        let fileHandle = await this.getFileHandle(key, false);
        if (!fileHandle) {
            return undefined;
        }
        let file = await fileHandle.getFile();
        return {
            size: file.size,
            lastModified: file.lastModified,
        };
    }
    public async reset(): Promise<void> {
        throw new Error("Not implemented");
    }
}