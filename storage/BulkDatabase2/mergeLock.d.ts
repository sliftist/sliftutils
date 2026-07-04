import type { FileStorage } from "../FileFolderAPI";
export type MergeLockInfo = {
    holderId: string;
    expiresInMs: number;
};
export declare function tryAcquireMergeLock(collection: string, holderId: string): boolean;
export declare function peekMergeLock(collection: string): MergeLockInfo | undefined;
export declare function releaseMergeLock(collection: string, holderId: string): void;
export declare function peekMergeFileLock(storage: FileStorage): Promise<MergeLockInfo | undefined>;
export declare function tryAcquireMergeFileLock(storage: FileStorage, holderId: string): Promise<boolean>;
export declare function startMergeFileLockHeartbeat(storage: FileStorage, holderId: string): () => void;
export declare function releaseMergeFileLock(storage: FileStorage, holderId: string): Promise<void>;
