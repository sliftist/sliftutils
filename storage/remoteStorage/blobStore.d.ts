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
    private memCache;
    private overlay;
    private writeQueue;
    private openBlobs;
    private largeUploads;
    private nextLargeUploadId;
    private currentBlobNumber;
    private currentBlobOffset;
    private currentBlobFd;
    private index;
    private deadBytes;
    private blobsDir;
    init: {
        (): Promise<void>;
        reset(): void;
        set(newValue: Promise<void>): void;
    };
    private blobName;
    private blobPath;
    private getBlobHandle;
    private closeBlobHandle;
    private addDeadBytes;
    private appendData;
    private setIndexEntry;
    set(key: string, data: Buffer, config?: WriteConfig): Promise<void>;
    del(key: string, config?: WriteConfig): Promise<void>;
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
    startLargeUpload(): Promise<string>;
    appendLargeUpload(id: string, data: Buffer): Promise<void>;
    finishLargeUpload(id: string, key: string): Promise<void>;
    cancelLargeUpload(id: string): Promise<void>;
    private flushOverlay;
    private compact;
}
