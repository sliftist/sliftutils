/// <reference types="node" />
/// <reference types="node" />
export declare class ArchivesBackblaze {
    private config;
    constructor(config: {
        bucketName: string;
        public?: boolean;
        immutable?: boolean;
        cacheTime?: number;
    });
    private bucketName;
    private bucketId;
    private logging;
    enableLogging(): void;
    private log;
    getDebugName(): string;
    private getBucketAPI;
    private last503Reset;
    private apiRetryLogic;
    get(fileName: string, config?: {
        range?: {
            start: number;
            end: number;
        };
        retryCount?: number;
    }): Promise<Buffer | undefined>;
    set(fileName: string, data: Buffer): Promise<void>;
    del(fileName: string): Promise<void>;
    setLargeFile(config: {
        path: string;
        getNextData(): Promise<Buffer | undefined>;
    }): Promise<void>;
    getInfo(fileName: string): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    find(prefix: string, config?: {
        shallow?: boolean;
        type: "files" | "folders";
    }): Promise<string[]>;
    findInfo(prefix: string, config?: {
        shallow?: boolean;
        type: "files" | "folders";
    }): Promise<{
        path: string;
        createTime: number;
        size: number;
    }[]>;
    assertPathValid(path: string): Promise<void>;
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
