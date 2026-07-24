/// <reference types="node" />
/// <reference types="node" />
import { IArchives, ArchiveFileInfo, ArchivesConfig, ChangesAfterConfig, FindConfig, GetConfig, GetInfoConfig } from "../IArchives";
export declare class ArchivesUrl implements IArchives {
    private base;
    constructor(base: string);
    getDebugName(): string;
    private readOnlyError;
    get(fileName: string, config?: GetConfig): Promise<Buffer | undefined>;
    get2(fileName: string, config?: GetConfig): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
    } | undefined>;
    getInfo(fileName: string, config?: GetInfoConfig): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    set(fileName: string, data: Buffer, config?: {
        lastModified?: number;
    }): Promise<string>;
    del(fileName: string): Promise<void>;
    setLargeFile(config: {
        path: string;
        getNextData(): Promise<Buffer | undefined>;
    }): Promise<void>;
    find(prefix: string, config?: FindConfig): Promise<string[]>;
    findInfo(prefix: string, config?: FindConfig): Promise<ArchiveFileInfo[]>;
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    getURL(path: string): Promise<string>;
    getConfig(): Promise<ArchivesConfig>;
    hasWriteAccess(): Promise<boolean>;
}
