import type { IArchives } from "./IArchives";
/** Copies one file between two archives. The source's CURRENT size and write time always come from getInfo right here - callers never supply them, because a stale size turns into ranged reads of a file that has changed (failing forever), and a stale write time re-orders history. Small files go as a single get2+set; past LARGE_COPY_THRESHOLD the copy streams through setLargeFile in LARGE_COPY_CHUNK ranged reads, so the whole file is never in memory. Returns the copied file's info, and undefined for every way the copy did NOT land: the source doesn't have the file, the destination already had a NEWER file (refused up front rather than roll it back), or the destination silently dropped the write (its own only-take-latest won a race we lost - caught by confirming with getInfo afterward). The refused/dropped cases are logged as errors; a caller that treats undefined as "missing at the source" must getInfo the destination to learn the actual latest value. */
export declare function copyArchiveFile(config: {
    from: IArchives;
    to: IArchives;
    path: string;
    /** The path at the destination - defaults to path (the common case: the same key moving between two archives). */
    toPath?: string;
    forceSetImmutable?: boolean;
    noChecks?: boolean;
    internal?: boolean;
    noFallbacks?: boolean;
}): Promise<{
    writeTime: number;
    size: number;
} | undefined>;
/**
 * Moves one file - between two archives, or between two paths of one. When from and to are the SAME
 * archives instance and it implements move, the backend moves the file itself (backblaze copies
 * server-side, disk renames, the storage server relocates it node-side) and the bytes never travel
 * through us. Everything else is the safe fallback: copy, then CONFIRM the destination actually
 * reports the file (getInfo), and only then delete the source - the one order in which no failure
 * can lose the file, only at worst leave it in both places. Throws when the source doesn't have the
 * file, or when the copy cannot be confirmed (the source is then left untouched).
 */
export declare function moveArchiveFile(config: {
    from: IArchives;
    to: IArchives;
    path: string;
    /** The path at the destination - defaults to path (moving between two archives). Required in practice when from and to are the same archives, where the same path would be a no-op. */
    toPath?: string;
    noFallbacks?: boolean;
}): Promise<void>;
