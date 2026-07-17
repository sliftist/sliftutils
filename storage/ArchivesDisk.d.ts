/// <reference types="node" />
/// <reference types="node" />
import { IArchives, ArchiveFileInfo, ArchivesConfig } from "./IArchives";
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
    private filePath;
    set(key: string, data: Buffer, config?: {
        lastModified?: number;
    }): Promise<void>;
    del(key: string): Promise<void>;
    get(key: string, config?: {
        range?: {
            start: number;
            end: number;
        };
    }): Promise<Buffer | undefined>;
    get2(key: string, config?: {
        range?: {
            start: number;
            end: number;
        };
    }): Promise<{
        data: Buffer;
        writeTime: number;
    } | undefined>;
    getInfo(key: string): Promise<{
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
        getNextData(): Promise<Buffer | undefined>;
    }): Promise<void>;
    startLargeUpload(): Promise<string>;
    appendLargeUpload(id: string, data: Buffer): Promise<void>;
    finishLargeUpload(id: string, key: string): Promise<void>;
    cancelLargeUpload(id: string): Promise<void>;
    getURL(path: string): Promise<string>;
}
export declare function applyFindInfoShape(files: ArchiveFileInfo[], prefix: string, config?: {
    shallow?: boolean;
    type?: "files" | "folders";
}): ArchiveFileInfo[];
