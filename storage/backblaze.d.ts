/// <reference types="node" />
/// <reference types="node" />
import { IArchives, ArchivesConfig, ChangesAfterConfig, ArchiveFileInfo, DelConfig, GetConfig, GetInfoConfig, SetConfig } from "./IArchives";
export declare class ArchivesBackblaze implements IArchives {
    private config;
    constructor(config: {
        bucketName: string;
        public?: boolean;
        immutable?: boolean;
        cacheTime?: number;
        allowedOrigins?: string[];
    });
    private bucketName;
    private bucketId;
    private logging;
    enableLogging(): void;
    private log;
    getDebugName(): string;
    private getBucketAPI;
    private currentReset;
    private last503Reset;
    private apiRetryLogic;
    get(fileName: string, config?: GetConfig): Promise<Buffer | undefined>;
    get2(fileName: string, config?: GetConfig): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
    } | undefined>;
    getConfig(): Promise<ArchivesConfig>;
    hasWriteAccess(): Promise<boolean>;
    set(fileName: string, data: Buffer, config?: SetConfig): Promise<string>;
    del(fileName: string, config?: DelConfig): Promise<void>;
    setLargeFile(config: {
        path: string;
        lastModified?: number;
        getNextData(): Promise<Buffer | undefined>;
    }): Promise<void>;
    getInfo(fileName: string, config?: GetInfoConfig): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    find(prefix: string, config?: {
        shallow?: boolean;
        type: "files" | "folders";
    }): Promise<string[]>;
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    findInfo(prefix: string, config?: {
        shallow?: boolean;
        type: "files" | "folders";
    }): Promise<{
        path: string;
        createTime: number;
        size: number;
    }[]>;
    assertPathValid(path: string): Promise<void>;
    move(config: {
        path: string;
        target: IArchives;
        targetPath: string;
        copyInstead?: boolean;
    }): Promise<void>;
    copy(config: {
        path: string;
        target: IArchives;
        targetPath: string;
    }): Promise<void>;
    getURL(path: string): Promise<string>;
    getDownloadAuthorization(config: {
        fileNamePrefix?: string;
        validDurationInSeconds: number;
        b2ContentDisposition?: string;
        b2ContentLanguage?: string;
        b2Expires?: string;
        b2CacheControl?: string;
        b2ContentEncoding?: string;
        b2ContentType?: string;
    }): Promise<{
        bucketId: string;
        fileNamePrefix: string;
        authorizationToken: string;
    }>;
}
export declare const getArchivesBackblaze: {
    (key: string): ArchivesBackblaze;
    clear(key: string): void;
    clearAll(): void;
    forceSet(key: string, value: ArchivesBackblaze): void;
    getAllKeys(): string[];
    get(key: string): ArchivesBackblaze | undefined;
};
export declare const getArchivesBackblazePrivateImmutable: {
    (key: string): ArchivesBackblaze;
    clear(key: string): void;
    clearAll(): void;
    forceSet(key: string, value: ArchivesBackblaze): void;
    getAllKeys(): string[];
    get(key: string): ArchivesBackblaze | undefined;
};
export declare const getArchivesBackblazePublicImmutable: {
    (key: string): ArchivesBackblaze;
    clear(key: string): void;
    clearAll(): void;
    forceSet(key: string, value: ArchivesBackblaze): void;
    getAllKeys(): string[];
    get(key: string): ArchivesBackblaze | undefined;
};
export declare const getArchivesBackblazePublic: {
    (key: string): ArchivesBackblaze;
    clear(key: string): void;
    clearAll(): void;
    forceSet(key: string, value: ArchivesBackblaze): void;
    getAllKeys(): string[];
    get(key: string): ArchivesBackblaze | undefined;
};
