/// <reference types="node" />
/// <reference types="node" />
/** Everything a log file's NAME says about it (plus its on-disk size). Times bound the entries roughly: from is when its process started writing it, to is when it was compressed. */
export type LogFileInfo = {
    name: string;
    /** Bytes on disk (compressed bytes for compressed files) */
    size: number;
    pid: number;
    processStartTime: number;
    threadId: string;
    /** When the process started writing this file */
    startTime: number;
    /** When the file was compressed - absent while it is still being streamed to */
    endTime?: number;
    /** How many entries it holds - only counted at compression, so absent on live files */
    entryCount?: number;
    compressed: boolean;
    /** Whether the writing process is still alive (always false for compressed files) */
    active: boolean;
};
/**
 * A searcher over one log file (as readFileCompressed returns it - always LZ4) that never decodes
 * the whole thing: JSON escapes line breaks inside strings, so the only ACTUAL line breaks in the
 * file are the separators between log statements - a plain substring search over the raw text,
 * bounded out to the surrounding line breaks, finds exactly the matching statements, and only THOSE
 * are decoded and returned as objects. Every search string must appear in a statement's raw JSON for
 * it to match (so search for values as they are encoded - e.g. quoted).
 */
export declare function createLogSearcher(data: Buffer): (searches: string[]) => unknown[];
/** Decodes a log file's bytes (as readFileCompressed returns them - always LZ4) back into the logged objects. A torn final line (the writer crashed mid-append) is skipped. */
export declare function decodeLogFile(data: Buffer): unknown[];
export declare class StreamingLogs {
    private config;
    constructor(config: {
        folder: string;
        /** Included in every file name - see misc/https/certs.ts getOwnThreadId. Processes without one write "none". */
        threadId?: string;
        maxFileBytes?: number;
        totalLimitBytes?: number;
    });
    private processStartTime;
    private threadId;
    private pending;
    private flushTimer;
    private maintenanceTimer;
    private writeChain;
    private currentPath;
    private currentBytes;
    private disposed;
    /** Queues one entry (anything JSON-serializable). Never throws - logging must not take down the caller. */
    log(entry: unknown): void;
    private scheduleFlush;
    flush(): Promise<void>;
    private writePending;
    /**
     * Compresses one finished log file: LZ4 into a temp SUBFOLDER (never a temp name in the log
     * folder itself - a crashed write must not leave a corrupt file where the maintenance scans are),
     * renamed into place (same drive, so the rename is atomic), verified, and only THEN is the
     * original deleted - at no point is the data in fewer than one complete file.
     */
    private compressFile;
    listFiles(): Promise<LogFileInfo[]>;
    /** One file's bytes, ALWAYS LZ4-compressed: compressed files are sent as-is, a still-streaming file is flushed and compressed in memory (smaller over the network; decodeLogFile handles both identically). */
    readFileCompressed(name: string): Promise<Buffer>;
    private scheduleMaintenance;
    /**
     * Shared upkeep of the folder - every process using it runs this, so nothing depends on any one
     * process surviving: dead processes' uncompressed files are compressed for them; duplicate
     * compressions of one stream (two maintainers racing) are resolved by keeping the OLDEST copy;
     * an uncompressed original whose compression already exists is deleted (its compressor died
     * between rename and unlink); and the folder's total size is brought under its budget by
     * deleting the oldest files.
     */
    runMaintenance(): Promise<void>;
    private enforceTotalLimit;
    dispose(): void;
}
