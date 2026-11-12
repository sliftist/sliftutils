import type { FileStorage } from "../FileFolderAPI";
export type MergeLockInfo = {
    holderId: string;
    expiresInMs: number;
};
export declare function tryAcquireMergeLock(collection: string, holderId: string): boolean;
export declare function peekMergeLock(collection: string): MergeLockInfo | undefined;
export declare function releaseMergeLock(collection: string, holderId: string): void;
export type MergeFileLockRead = {
    readAt: number;
    token?: {
        holderId: string;
        time: number;
    };
    raw?: string;
    error?: string;
};
export declare function peekMergeFileLock(storage: FileStorage): Promise<MergeLockInfo | undefined>;
export type MergeFileLockAttempt = {
    acquired: boolean;
    holderId: string;
    lockPath: string;
    ttlMs: number;
    settleMs: number;
    before: MergeFileLockRead;
    wroteAt?: number;
    after?: MergeFileLockRead;
};
export declare function describeMergeFileLockAttempt(attempt: MergeFileLockAttempt): string;
export declare function tryAcquireMergeFileLock(storage: FileStorage, holderId: string, lockPath: string): Promise<MergeFileLockAttempt>;
export declare function startMergeFileLockHeartbeat(storage: FileStorage, holderId: string): () => void;
export declare function releaseMergeFileLock(storage: FileStorage, holderId: string): Promise<void>;
