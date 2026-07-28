import os from "os";
import path from "path";
import { lazy } from "socket-function/src/caching";
import { StreamingLogs, LogFileInfo } from "../StreamingLogs";
import { getStorageFolder, getStorageServerConfigOptional } from "./serverConfig";
import { getOwnThreadId } from "../../misc/https/certs";

// The storage server's operation log: every mutation (never the data itself - just what happened, to what, when, how big, and who asked), every error, and the synchronization key points, streamed as JSON lines into <storage folder>/logs (see StreamingLogs for the file lifecycle). Everything here is a safe no-op on processes that have no storage folder - logging must never be the thing that breaks a request.

export const LOGS_FOLDER_NAME = "logs";

// NOT lazy: a failure to resolve the folder (the server config may simply not be SET yet this early in startup) must be retried on the next log call, not cached as "no logs ever"
let logsInstance: StreamingLogs | undefined;
function getLogs(): StreamingLogs | undefined {
    if (logsInstance) return logsInstance;
    let folder: string;
    try {
        folder = path.join(getStorageFolder(), LOGS_FOLDER_NAME);
    } catch {
        return undefined;
    }
    hookErrorLogging();
    logsInstance = new StreamingLogs({ folder, threadId: getThreadIdSafe() });
    return logsInstance;
}

function firstExternalIPv4(): string | undefined {
    for (let addresses of Object.values(os.networkInterfaces())) {
        for (let address of addresses || []) {
            if (address.family === "IPv4" && !address.internal) return address.address;
        }
    }
    return undefined;
}

// Memoized on SUCCESS only: the thread cert may not be loaded yet when the first entries are written, and that must not permanently strip the thread id from every later entry
let cachedThreadId: string | undefined;
function getThreadIdSafe(): string | undefined {
    if (cachedThreadId) return cachedThreadId;
    try {
        cachedThreadId = getOwnThreadId(getStorageServerConfigOptional()?.rootDomain || "");
    } catch { }
    return cachedThreadId;
}

const cachedIp = lazy(() => firstExternalIPv4());

// threadId and domain are re-resolved until known (early entries may predate the config/certs); the rest never changes
function baseFields() {
    return {
        pid: process.pid,
        threadId: getThreadIdSafe(),
        entryPoint: process.argv[1],
        ip: cachedIp(),
        domain: getStorageServerConfigOptional()?.domain,
    };
}

// Everything logged here goes BOTH to the storage log stream and the console - one call, never two. The console line carries only the entry (the base fields are constant per process, so they would just be noise there); the stream gets everything.
function write(kind: string, entry: { [key: string]: unknown }, alsoConsole: boolean): void {
    if (alsoConsole) {
        console.log(`[${kind}] ${JSON.stringify(entry)}`);
    }
    let logs = getLogs();
    if (!logs) return;
    logs.log({ kind, time: Date.now(), ...baseFields(), ...entry });
}

/** One mutation the server performed: set/del/move/undelete/setLarge/routingConfig, plus the per-file synchronization writes ("sync get"/"sync set"). Sizes and times, never the data. internal marks writes pushed by a peer's synchronization rather than a client. Logged DELIBERATELY at two layers: the controller (which knows the account/bucket and the caller) AND BlobStore itself (which knows the folder, and sees the writes that never pass through the controller) - the redundancy is the point, because a write that only one layer saw is exactly the kind of masked issue these logs exist to expose. Stream-only - one entry per write is exactly what the console does NOT need. */
export function logMutation(entry: { op: string; account?: string; bucketName?: string; store?: string; folder?: string; path: string; toPath?: string; size?: number; writeTime?: number; callerId?: string; internal?: boolean }): void {
    write("mutation", entry, false);
}

/** A synchronization key point: scans and full syncs starting/finishing, reconciles, boundary scans - what an operator greps for to see whether the fleet is converging. Also printed to the console. */
export function logSyncEvent(entry: { event: string; store: string; source?: string; [key: string]: unknown }): void {
    write("sync", entry, true);
}

/** One console.error is all an error takes (console.error and console.warn are HOOKED to feed the stream) - this just guarantees the hook is installed first, for very-early callers. */
export function logStorageError(message: string): void {
    getLogs();
    console.error(message);
}

/** logStorageError at warn level: guarantees the console.warn hook is installed before warning, so warnings from before the first logged mutation still reach the stream. */
export function logStorageWarn(message: string): void {
    getLogs();
    console.warn(message);
}

// Everything console.errored or console.warned also lands in the log stream (with a reentrancy guard: a failure INSIDE logging must not log itself forever)
let writingHooked = false;
const hookErrorLogging = lazy(() => {
    for (let level of ["error", "warn"] as const) {
        let original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            original(...args);
            if (writingHooked) return;
            writingHooked = true;
            try {
                write(level, { message: args.map(x => typeof x === "string" && x || ((x as Error)?.stack ?? JSON.stringify(x))).join(" ").slice(0, 5000) }, false);
            } catch { } finally {
                writingHooked = false;
            }
        };
    }
});

/** The log files this server holds - see StreamingLogs.listFiles. Empty on processes with no storage folder. */
export async function listStorageLogFiles(): Promise<LogFileInfo[]> {
    let logs = getLogs();
    if (!logs) return [];
    return await logs.listFiles();
}

/** One log file's bytes, always LZ4-compressed - see StreamingLogs.readFileCompressed (decode with decodeLogFile). */
export async function readStorageLogFile(name: string): Promise<Buffer> {
    let logs = getLogs();
    if (!logs) {
        throw new Error(`This process has no storage folder, so it has no logs to read`);
    }
    return await logs.readFileCompressed(name);
}
