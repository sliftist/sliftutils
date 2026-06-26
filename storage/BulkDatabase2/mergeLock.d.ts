import type { FileStorage } from "../FileFolderAPI";
export declare function tryAcquireMergeLock(collection: string, holderId: string): boolean;
export declare function releaseMergeLock(collection: string, holderId: string): void;
export declare function tryAcquireMergeFileLock(storage: FileStorage, holderId: string): Promise<boolean>;
export declare function startMergeFileLockHeartbeat(storage: FileStorage, holderId: string): () => void;
export declare function releaseMergeFileLock(storage: FileStorage, holderId: string): Promise<void>;
