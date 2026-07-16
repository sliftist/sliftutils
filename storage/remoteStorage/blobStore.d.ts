/// <reference types="node" />
/// <reference types="node" />
import { ArchiveFileInfo } from "../IArchives";
export declare const DEFAULT_FAST_WRITE_DELAY: number;
export type WriteConfig = {
    fast?: boolean;
    writeDelay?: number;
};
export declare class BlobStore {
    private folder;
    constructor(folder: string);
    private filesDir;
    private uploadsDir;
    private handles;
    private overlay;
    private largeUploads;
    private nextLargeUploadId;
    init: {
        (): Promise<void>;
        reset(): void;
        set(newValue: Promise<void>): void;
    };
    private filePath;
    set(key: string, data: Buffer, config?: WriteConfig): Promise<void>;
    private writeToDisk;
    del(key: string, config?: WriteConfig): Promise<void>;
    private deleteFromDisk;
    get(key: string, range?: {
        start: number;
        end: number;
    }): Promise<Buffer | undefined>;
    getInfo(key: string): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo(prefix: string, config?: {
        shallow?: boolean;
        type?: "files" | "folders";
    }): Promise<ArchiveFileInfo[]>;
    private collectFiles;
    startLargeUpload(): Promise<string>;
    appendLargeUpload(id: string, data: Buffer): Promise<void>;
    finishLargeUpload(id: string, key: string): Promise<void>;
    cancelLargeUpload(id: string): Promise<void>;
    private flushOverlay;
}
