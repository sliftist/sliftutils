/// <reference types="node" />
/// <reference types="node" />
import { LogFileInfo } from "../StreamingLogs";
export declare const LOGS_FOLDER_NAME = "logs";
/** One mutation the server performed: set/del/move/undelete/setLarge/routingConfig, plus the per-file synchronization writes ("sync get"/"sync set"). Sizes and times, never the data. internal marks writes pushed by a peer's synchronization rather than a client. Logged DELIBERATELY at two layers: the controller (which knows the account/bucket and the caller) AND BlobStore itself (which knows the folder, and sees the writes that never pass through the controller) - the redundancy is the point, because a write that only one layer saw is exactly the kind of masked issue these logs exist to expose. Stream-only - one entry per write is exactly what the console does NOT need. */
export declare function logMutation(entry: {
    op: string;
    account?: string;
    bucketName?: string;
    store?: string;
    folder?: string;
    path: string;
    toPath?: string;
    size?: number;
    writeTime?: number;
    callerId?: string;
    internal?: boolean;
}): void;
/** A synchronization key point: scans and full syncs starting/finishing, reconciles, boundary scans - what an operator greps for to see whether the fleet is converging. Also printed to the console. */
export declare function logSyncEvent(entry: {
    event: string;
    store: string;
    source?: string;
    [key: string]: unknown;
}): void;
/** One console.error is all an error takes (console.error and console.warn are HOOKED to feed the stream) - this just guarantees the hook is installed first, for very-early callers. */
export declare function logStorageError(message: string): void;
/** logStorageError at warn level: guarantees the console.warn hook is installed before warning, so warnings from before the first logged mutation still reach the stream. */
export declare function logStorageWarn(message: string): void;
/** The log files this server holds - see StreamingLogs.listFiles. Empty on processes with no storage folder. */
export declare function listStorageLogFiles(): Promise<LogFileInfo[]>;
/** One log file's bytes, always LZ4-compressed - see StreamingLogs.readFileCompressed (decode with decodeLogFile). */
export declare function readStorageLogFile(name: string): Promise<Buffer>;
