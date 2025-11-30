import { IStorageRaw } from "./IStorage";

export class PrivateFileSystemStorage implements IStorageRaw {
    private rootHandle: FileSystemDirectoryHandle | undefined;

    constructor(private path: string) { }

    private async ensureInitialized(): Promise<FileSystemDirectoryHandle> {
        if (!this.rootHandle) {
            if (!navigator.storage?.getDirectory) {
                throw new Error("Private File System Access API not supported in this browser");
            }
            this.rootHandle = await navigator.storage.getDirectory();
        }
        return this.rootHandle;
    }

    private async directoryExists(): Promise<boolean> {
        try {
            const root = await this.ensureInitialized();

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

    private async getFileHandle(key: string, create: boolean = false): Promise<FileSystemFileHandle | undefined> {
        try {
            const dirHandle = await this.getDirectoryHandle(create);
            return await dirHandle.getFileHandle(key, { create });
        } catch (error) {
            return undefined;
        }
    }

    private async fileExists(key: string): Promise<boolean> {
        try {
            // First check if directory exists
            if (!(await this.directoryExists())) {
                return false;
            }

            const dirHandle = await this.getDirectoryHandle(false);
            await dirHandle.getFileHandle(key);
            return true;
        } catch (error) {
            return false;
        }
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

    public async set(key: string, value: Buffer): Promise<void> {
        try {
            const fileHandle = await this.getFileHandle(key, true);
            if (!fileHandle) {
                throw new Error(`Failed to create file handle for key: ${key}`);
            }

            const writable = await fileHandle.createWritable();
            await writable.write(value);
            await writable.close();
        } catch (error) {
            throw new Error(`Failed to write file ${key}: ${error}`);
        }
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

        try {
            const dirHandle = await this.getDirectoryHandle(false);
            await dirHandle.removeEntry(key);
        } catch { }
    }

    public async getKeys(): Promise<string[]> {
        // Check if directory exists first to avoid unnecessary errors
        if (!(await this.directoryExists())) {
            return [];
        }

        try {
            const dirHandle = await this.getDirectoryHandle(false);
            const keys: string[] = [];

            // Use the async iterator protocol for FileSystemDirectoryHandle
            for await (const [name, handle] of (dirHandle as any).entries()) {
                if (handle.kind === "file") {
                    keys.push(name);
                }
            }

            return keys.sort();
        } catch (error) {
            if (error instanceof Error && error.message.includes("Directory not found")) {
                return [];
            }
            throw new Error(`Failed to list files: ${error}`);
        }
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