/// <reference types="node" />
/// <reference types="node" />
import { IArchives, ArchiveFileInfo, ArchivesConfig, ChangesAfterConfig, DelConfig, GetConfig, GetInfoConfig, SetConfig } from "./IArchives";
export declare class ArchivesDisk implements IArchives {
    private folder;
    constructor(folder: string);
    private filesDir;
    private uploadsDir;
    private handles;
    private largeUploads;
    private nextLargeUploadId;
    init: {
        (): Promise<void>;
        reset(): void;
        set(newValue: Promise<void>): void;
    };
    getDebugName(): string;
    getConfig(): Promise<ArchivesConfig>;
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    hasWriteAccess(): Promise<boolean>;
    private filePath;
    set(key: string, data: Buffer, config?: SetConfig): Promise<string>;
    del(key: string, config?: DelConfig): Promise<void>;
    get(key: string, config?: GetConfig): Promise<Buffer | undefined>;
    get2(key: string, config?: GetConfig): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
    } | undefined>;
    getInfo(key: string, config?: GetInfoConfig): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    find(prefix: string, config?: {
        shallow?: boolean;
        type: "files" | "folders";
    }): Promise<string[]>;
    findInfo(prefix: string, config?: {
        shallow?: boolean;
        type?: "files" | "folders";
    }): Promise<ArchiveFileInfo[]>;
    private collectFiles;
    setLargeFile(config: {
        path: string;
        lastModified?: number;
        getNextData(): Promise<Buffer | undefined>;
    }): Promise<void>;
    startLargeUpload(): Promise<string>;
    appendLargeUpload(id: string, data: Buffer): Promise<void>;
    finishLargeUpload(id: string, key: string, lastModified?: number): Promise<void>;
    cancelLargeUpload(id: string): Promise<void>;
    getURL(path: string): Promise<string>;
}
export declare function applyFindInfoShape(files: ArchiveFileInfo[], prefix: string, config?: {
    shallow?: boolean;
    type?: "files" | "folders";
}): ArchiveFileInfo[];
