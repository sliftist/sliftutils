import fs from "fs";
import path from "path";
import { sort } from "socket-function/src/misc";
import { LZ4 } from "socket-function/src/lz4/LZ4";

// Generic append-only JSON-lines logging over a folder. Every process streams to its OWN file (named by pid + process start time + thread id, which together identify a process incarnation), rotating to a new file at a size limit and LZ4-compressing the finished one. Every process using the folder also MAINTAINS it on a randomized interval: dead processes' files are compressed for them, duplicate compressions are resolved, and the oldest files are deleted once the folder outgrows its byte budget. Instantiate one per folder and call log().

// Appends are coalesced for this long; a crash loses at most this much
const FLUSH_DELAY = 5000;
// A file reaching this size is rotated out and compressed
const MAX_FILE_BYTES = 100 * 1024 * 1024;
// The folder's total budget; once exceeded, the oldest files are deleted
const TOTAL_LIMIT_BYTES = 30 * 1024 * 1024 * 1024;
// Maintenance runs at a random point in this range, so the processes sharing the folder drift apart instead of stepping on each other every pass
const MAINTENANCE_MIN_INTERVAL = 30 * 60 * 1000;
const MAINTENANCE_MAX_INTERVAL = 60 * 60 * 1000;
// A pid is only the same PROCESS if its start time matches the file name's - within this much, because our own start time is derived from process.uptime and the OS's is read off /proc
const PROCESS_START_TOLERANCE = 60 * 1000;
// If flushing fails persistently (disk gone), pending entries are capped rather than growing forever
const MAX_PENDING_ENTRIES = 10000;

const UNCOMPRESSED_EXT = ".jsonl";
const COMPRESSED_EXT = ".jsonl.lz4";

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

type ParsedName = {
    pid: number;
    processStartTime: number;
    threadId: string;
    startTime: number;
    endTime?: number;
    entryCount?: number;
    compressed: boolean;
    /** The part identifying the ORIGINAL stream (pid+born+thread+from) - what duplicate compressions share */
    originKey: string;
};

function parseLogFileName(name: string): ParsedName | undefined {
    // The time fields accept a fractional part: hosts that shim Date.now to a true-time clock return fractional milliseconds, and files written before the writer rounded them are already on disk everywhere - they must stay listable (and maintainable, or they would never be compressed or cleaned).
    let match = /^pid(\d+)_born(\d+)_thread([\w-]+?)_from(\d+(?:\.\d+)?)(?:_to(\d+(?:\.\d+)?)_count(\d+)_id([a-z0-9]+))?\.jsonl(\.lz4)?$/.exec(name);
    if (!match) return undefined;
    let compressed = !!match[8];
    // A compressed file without its compression fields (or the reverse) is not one of ours
    if (compressed !== (match[5] !== undefined)) return undefined;
    return {
        pid: +match[1],
        processStartTime: +match[2],
        threadId: match[3],
        startTime: +match[4],
        endTime: match[5] !== undefined && +match[5] || undefined,
        entryCount: match[6] !== undefined && +match[6] || undefined,
        compressed,
        originKey: `pid${match[1]}_born${match[2]}_thread${match[3]}_from${match[4]}`,
    };
}

/** Whether the pid is alive AND is the same process incarnation the file name described. On Linux /proc gives the real start time; elsewhere a live pid is conservatively treated as the same process (never compress under a running process). */
async function isProcessAlive(pid: number, processStartTime: number): Promise<boolean> {
    try {
        process.kill(pid, 0);
    } catch {
        return false;
    }
    try {
        let stat = await fs.promises.stat(`/proc/${pid}`);
        return Math.abs(stat.ctimeMs - processStartTime) < PROCESS_START_TOLERANCE;
    } catch {
        return true;
    }
}

/**
 * A searcher over one log file (as readFileCompressed returns it - always LZ4) that never decodes
 * the whole thing: JSON escapes line breaks inside strings, so the only ACTUAL line breaks in the
 * file are the separators between log statements - a plain substring search over the raw text,
 * bounded out to the surrounding line breaks, finds exactly the matching statements, and only THOSE
 * are decoded and returned as objects. Every search string must appear in a statement's raw JSON for
 * it to match (so search for values as they are encoded - e.g. quoted).
 */
export function createLogSearcher(data: Buffer): (searches: string[]) => unknown[] {
    let text = LZ4.decompress(data).toString("utf8");
    return searches => {
        if (!searches.length) {
            throw new Error(`Provide at least one search string (an empty search would just be decodeLogFile)`);
        }
        let entries: unknown[] = [];
        let index = 0;
        while (true) {
            let found = text.indexOf(searches[0], index);
            if (found === -1) break;
            let lineStart = text.lastIndexOf("\n", found) + 1;
            let lineEnd = text.indexOf("\n", found);
            if (lineEnd === -1) {
                lineEnd = text.length;
            }
            // Past this line either way, so several matches inside one statement return it once
            index = lineEnd + 1;
            let line = text.slice(lineStart, lineEnd);
            let matchesAll = true;
            for (let other of searches.slice(1)) {
                if (!line.includes(other)) {
                    matchesAll = false;
                    break;
                }
            }
            if (!matchesAll) continue;
            try {
                entries.push(JSON.parse(line));
            } catch {
                // A torn final line (the writer crashed mid-append)
                continue;
            }
        }
        return entries;
    };
}

/** Decodes a log file's bytes (as readFileCompressed returns them - always LZ4) back into the logged objects. A torn final line (the writer crashed mid-append) is skipped. */
export function decodeLogFile(data: Buffer): unknown[] {
    let text = LZ4.decompress(data).toString("utf8");
    let entries: unknown[] = [];
    for (let line of text.split("\n")) {
        if (!line) continue;
        try {
            entries.push(JSON.parse(line));
        } catch {
            continue;
        }
    }
    return entries;
}

export class StreamingLogs {
    constructor(private config: {
        folder: string;
        /** Included in every file name - see misc/https/certs.ts getOwnThreadId. Processes without one write "none". */
        threadId?: string;
        maxFileBytes?: number;
        totalLimitBytes?: number;
    }) {
        this.scheduleMaintenance();
    }

    private processStartTime = Math.round(Date.now() - process.uptime() * 1000);
    private threadId = (this.config.threadId || "none").replace(/[^\w-]/g, "_");
    private pending: string[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | undefined;
    private maintenanceTimer: ReturnType<typeof setTimeout> | undefined;
    // Serializes everything that touches the current file, so appends, rotation, and in-memory compression of the live file never interleave
    private writeChain: Promise<void> = Promise.resolve();
    private currentPath: string | undefined;
    private currentBytes = 0;
    private disposed = false;

    /** Queues one entry (anything JSON-serializable). Never throws - logging must not take down the caller. */
    public log(entry: unknown): void {
        try {
            if (this.pending.length >= MAX_PENDING_ENTRIES) {
                // The disk is broken (flushes are failing) - dropping the oldest beats growing forever
                this.pending.shift();
            }
            this.pending.push(JSON.stringify(entry));
            this.scheduleFlush();
        } catch (e) {
            console.warn(`Could not queue a log entry (${(e as Error).message})`);
        }
    }

    private scheduleFlush(): void {
        if (this.flushTimer !== undefined || this.disposed) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            void this.flush().catch((e: Error) => console.warn(`Flushing logs in ${this.config.folder} failed: ${e.stack ?? e}`));
        }, FLUSH_DELAY);
        (this.flushTimer as { unref?: () => void }).unref?.();
    }

    public async flush(): Promise<void> {
        let result = this.writeChain.then(() => this.writePending());
        // The chain only serializes; a failure belongs to the caller that asked for this flush, not every one after it
        this.writeChain = result.catch(() => { });
        await result;
    }

    private async writePending(): Promise<void> {
        if (!this.pending.length) return;
        let lines = this.pending;
        this.pending = [];
        let data = lines.join("\n") + "\n";
        try {
            if (!this.currentPath) {
                await fs.promises.mkdir(this.config.folder, { recursive: true });
                // Rounded, as a shimmed Date.now can return fractional milliseconds, and a "." in the name breaks name parsing for any reader without the fractional-tolerant regex
                this.currentPath = path.join(this.config.folder, `pid${process.pid}_born${this.processStartTime}_thread${this.threadId}_from${Math.round(Date.now())}${UNCOMPRESSED_EXT}`);
                this.currentBytes = 0;
            }
            await fs.promises.appendFile(this.currentPath, data);
            this.currentBytes += Buffer.byteLength(data);
        } catch (e) {
            this.pending = lines.concat(this.pending);
            this.scheduleFlush();
            throw e;
        }
        if (this.currentBytes >= (this.config.maxFileBytes || MAX_FILE_BYTES)) {
            let finished = this.currentPath;
            this.currentPath = undefined;
            this.currentBytes = 0;
            void this.compressFile(finished).catch((e: Error) => {
                // Left uncompressed: maintenance (ours after death, or any peer's) compresses it later
                console.warn(`Compressing rotated log ${finished} failed: ${e.stack ?? e}`);
            });
        }
    }

    /**
     * Compresses one finished log file: LZ4 into a temp SUBFOLDER (never a temp name in the log
     * folder itself - a crashed write must not leave a corrupt file where the maintenance scans are),
     * renamed into place (same drive, so the rename is atomic), verified, and only THEN is the
     * original deleted - at no point is the data in fewer than one complete file.
     */
    private async compressFile(filePath: string): Promise<void> {
        let name = path.basename(filePath);
        let parsed = parseLogFileName(name);
        if (!parsed || parsed.compressed) return;
        let raw = await fs.promises.readFile(filePath);
        let entryCount = 0;
        for (let i = 0; i < raw.length; i++) {
            if (raw[i] === 10) entryCount++;
        }
        let compressed = LZ4.compress(raw);
        let id = Math.random().toString(36).slice(2, 10);
        let finalName = `${parsed.originKey}_to${Math.round(Date.now())}_count${entryCount}_id${id}${COMPRESSED_EXT}`;
        let tempDir = path.join(this.config.folder, ".tmp");
        await fs.promises.mkdir(tempDir, { recursive: true });
        let tempPath = path.join(tempDir, finalName);
        let finalPath = path.join(this.config.folder, finalName);
        await fs.promises.writeFile(tempPath, compressed);
        await fs.promises.rename(tempPath, finalPath);
        // Paranoia before deleting the only other copy
        await fs.promises.stat(finalPath);
        await fs.promises.unlink(filePath);
        console.log(`Compressed log ${name} -> ${finalName} (${raw.length} -> ${compressed.length} bytes, ${entryCount} entries)`);
    }

    // ── listing / reading ──

    public async listFiles(): Promise<LogFileInfo[]> {
        let names: string[];
        try {
            names = await fs.promises.readdir(this.config.folder);
        } catch (e) {
            if ((e as { code?: string }).code === "ENOENT") return [];
            throw e;
        }
        let files: LogFileInfo[] = [];
        for (let name of names) {
            let parsed = parseLogFileName(name);
            if (!parsed) continue;
            let stat = await fs.promises.stat(path.join(this.config.folder, name)).catch(() => undefined);
            if (!stat) continue;
            let active = !parsed.compressed && await isProcessAlive(parsed.pid, parsed.processStartTime);
            files.push({
                name,
                size: stat.size,
                pid: parsed.pid,
                processStartTime: parsed.processStartTime,
                threadId: parsed.threadId,
                startTime: parsed.startTime,
                endTime: parsed.endTime,
                entryCount: parsed.entryCount,
                compressed: parsed.compressed,
                active,
            });
        }
        sort(files, x => x.startTime);
        return files;
    }

    /** One file's bytes, ALWAYS LZ4-compressed: compressed files are sent as-is, a still-streaming file is flushed and compressed in memory (smaller over the network; decodeLogFile handles both identically). */
    public async readFileCompressed(name: string): Promise<Buffer> {
        let parsed = parseLogFileName(name);
        if (!parsed || name.includes("/") || name.includes("\\")) {
            throw new Error(`Not a log file name: ${JSON.stringify(name.slice(0, 200))}`);
        }
        let filePath = path.join(this.config.folder, name);
        if (parsed.compressed) {
            return await fs.promises.readFile(filePath);
        }
        // Flush so our own live file includes everything logged up to now
        await this.flush();
        return LZ4.compress(await fs.promises.readFile(filePath));
    }

    // ── maintenance ──

    private scheduleMaintenance(): void {
        if (this.disposed) return;
        let wait = MAINTENANCE_MIN_INTERVAL + Math.random() * (MAINTENANCE_MAX_INTERVAL - MAINTENANCE_MIN_INTERVAL);
        this.maintenanceTimer = setTimeout(() => {
            void this.runMaintenance().catch((e: Error) => console.warn(`Log maintenance of ${this.config.folder} failed: ${e.stack ?? e}`)).finally(() => this.scheduleMaintenance());
        }, wait);
        (this.maintenanceTimer as { unref?: () => void }).unref?.();
    }

    /**
     * Shared upkeep of the folder - every process using it runs this, so nothing depends on any one
     * process surviving: dead processes' uncompressed files are compressed for them; duplicate
     * compressions of one stream (two maintainers racing) are resolved by keeping the OLDEST copy;
     * an uncompressed original whose compression already exists is deleted (its compressor died
     * between rename and unlink); and the folder's total size is brought under its budget by
     * deleting the oldest files.
     */
    public async runMaintenance(): Promise<void> {
        let names: string[];
        try {
            names = await fs.promises.readdir(this.config.folder);
        } catch (e) {
            if ((e as { code?: string }).code === "ENOENT") return;
            throw e;
        }
        let parsedByName = new Map<string, ParsedName>();
        for (let name of names) {
            let parsed = parseLogFileName(name);
            if (parsed) parsedByName.set(name, parsed);
        }
        let compressedOrigins = new Map<string, string[]>();
        for (let [name, parsed] of parsedByName) {
            if (!parsed.compressed) continue;
            let list = compressedOrigins.get(parsed.originKey);
            if (!list) {
                list = [];
                compressedOrigins.set(parsed.originKey, list);
            }
            list.push(name);
        }
        // Duplicate compressions: keep the oldest (first written), delete the rest
        for (let [origin, list] of compressedOrigins) {
            if (list.length < 2) continue;
            sort(list, name => parsedByName.get(name)?.endTime || 0);
            for (let duplicate of list.slice(1)) {
                console.log(`Deleting duplicate compressed log ${duplicate} (another maintainer compressed ${origin} first, keeping ${list[0]})`);
                await fs.promises.unlink(path.join(this.config.folder, duplicate)).catch(() => { });
                parsedByName.delete(duplicate);
            }
        }
        for (let [name, parsed] of parsedByName) {
            if (parsed.compressed) continue;
            let filePath = path.join(this.config.folder, name);
            if (filePath === this.currentPath) continue;
            if (compressedOrigins.has(parsed.originKey)) {
                // Already compressed by someone whose cleanup died between rename and unlink
                console.log(`Deleting uncompressed log ${name}: its compressed version already exists`);
                await fs.promises.unlink(filePath).catch(() => { });
                continue;
            }
            // A live process owns its uncompressed file; only a DEAD process's files are compressed for it (our own pid always reads as alive, which correctly protects our current file - our rotated leftovers were excluded above only if current, so compress those too)
            if (parsed.pid !== process.pid && await isProcessAlive(parsed.pid, parsed.processStartTime)) continue;
            try {
                await this.compressFile(filePath);
            } catch (e) {
                console.warn(`Compressing dead process's log ${name} failed (the next maintenance pass retries): ${(e as Error).stack ?? e}`);
            }
        }
        await this.enforceTotalLimit();
    }

    private async enforceTotalLimit(): Promise<void> {
        let limit = this.config.totalLimitBytes || TOTAL_LIMIT_BYTES;
        let files = await this.listFiles();
        let total = files.reduce((sum, x) => sum + x.size, 0);
        if (total <= limit) return;
        // Oldest first, by the end of what they cover; live files last (they are the newest data by definition)
        let deletable = files.filter(x => !x.active);
        sort(deletable, x => x.endTime || x.startTime);
        let deleted = 0;
        let deletedBytes = 0;
        for (let file of deletable) {
            if (total <= limit) break;
            await fs.promises.unlink(path.join(this.config.folder, file.name)).catch(() => { });
            total -= file.size;
            deleted++;
            deletedBytes += file.size;
        }
        console.log(`Logs in ${this.config.folder} outgrew their ${limit} byte budget: deleted the ${deleted} oldest files (${deletedBytes} bytes), ${total} bytes remain`);
    }

    public dispose(): void {
        this.disposed = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
        }
        if (this.maintenanceTimer) {
            clearTimeout(this.maintenanceTimer);
        }
    }
}
