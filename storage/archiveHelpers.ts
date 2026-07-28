// Type-only: IArchives.ts re-exports our functions, so a value import back at it would be a require cycle
import type { IArchives } from "./IArchives";
import { formatDateTimeDetailed } from "socket-function/src/formatting/format";
import { logStorageError } from "./remoteStorage/storageLogs";

// Cross-archive file operations built ON TOP of IArchives (copy, move) - helpers over the interface, not part of it, so they live beside it rather than in it.

const LARGE_COPY_THRESHOLD = 64 * 1024 * 1024;
const LARGE_COPY_CHUNK = 32 * 1024 * 1024;

/** Copies one file between two archives. The source's CURRENT size and write time always come from getInfo right here - callers never supply them, because a stale size turns into ranged reads of a file that has changed (failing forever), and a stale write time re-orders history. Small files go as a single get2+set; past LARGE_COPY_THRESHOLD the copy streams through setLargeFile in LARGE_COPY_CHUNK ranged reads, so the whole file is never in memory. Returns the copied file's info, and undefined for every way the copy did NOT land: the source doesn't have the file, the destination already had a NEWER file (refused up front rather than roll it back), or the destination silently dropped the write (its own only-take-latest won a race we lost - caught by confirming with getInfo afterward). The refused/dropped cases are logged as errors; a caller that treats undefined as "missing at the source" must getInfo the destination to learn the actual latest value. */
export async function copyArchiveFile(config: {
    from: IArchives;
    to: IArchives;
    path: string;
    /** The path at the destination - defaults to path (the common case: the same key moving between two archives). */
    toPath?: string;
    forceSetImmutable?: boolean;
    noChecks?: boolean;
    internal?: boolean;
    noFallbacks?: boolean;
}): Promise<{ writeTime: number; size: number } | undefined> {
    let { from, to, path } = config;
    let toPath = config.toPath || path;
    let info = await from.getInfo(path, { noFallbacks: config.noFallbacks });
    if (!info) return undefined;
    let size = info.size;
    // internal (synchronization between replicas of the same key) preserves the source's write time, so ordering survives propagation. A plain copy is a NEW write and is stamped now: the source's old stamp would make it LOSE to any newer write or tombstone at the destination, silently - move a file back to a folder it was deleted from and the copy is dropped, then the caller deletes the source, and the file is gone entirely.
    let writeTime = Math.floor(config.internal && info.writeTime || Date.now());
    // A destination that already holds a NEWER file must not be overwritten with our older one - and the destination's own only-take-latest would drop the write SILENTLY, leaving the caller believing the copy happened. Refusing here, loudly, is what turns "the remote has something we missed" from a masked bug into a log line the caller can act on.
    let destInfo = await to.getInfo(toPath, { noFallbacks: config.noFallbacks });
    // Compared at whole-millisecond precision, here and at the confirm below: disk mtimes carry fractional milliseconds, but utimes round-trips only whole ones, so sub-millisecond differences are storage artifacts of the SAME time, not ordering
    if (destInfo && Math.floor(destInfo.writeTime) > Math.floor(writeTime)) {
        logStorageError(`Copy refused - a newer file exists at the destination. Refusing to copy ${JSON.stringify(path)} from ${from.getDebugName()} to ${to.getDebugName()}${toPath !== path && ` (as ${JSON.stringify(toPath)})` || ""}: ours ${size} bytes at ${formatDateTimeDetailed(writeTime)}, theirs ${destInfo.size} bytes at ${formatDateTimeDetailed(destInfo.writeTime)} - copying would roll it back`);
        return undefined;
    }
    let copiedSize: number;
    if (size <= LARGE_COPY_THRESHOLD) {
        let result = await from.get2(path, { internal: config.internal, noFallbacks: config.noFallbacks });
        // Empty counts as absent, never as content to copy: an empty file IS a deletion, set refuses empty buffers, and deletions travel through their own path (del / scan tombstones)
        if (!result || !result.data || !result.data.length) return undefined;
        await to.set(toPath, result.data, { lastModified: writeTime, forceSetImmutable: config.forceSetImmutable, noChecks: config.noChecks, internal: config.internal });
        copiedSize = result.data.length;
    } else {
        // Const so the closure keeps the narrowed type
        const totalSize = size;
        let offset = 0;
        await to.setLargeFile({
            path: toPath,
            lastModified: writeTime,
            forceSetImmutable: config.forceSetImmutable,
            noChecks: config.noChecks,
            internal: config.internal,
            restartStream: () => {
                offset = 0;
            },
            getNextData: async () => {
                if (offset >= totalSize) return undefined;
                let end = Math.min(offset + LARGE_COPY_CHUNK, totalSize);
                let data = await from.get(path, { range: { start: offset, end }, internal: config.internal, noFallbacks: config.noFallbacks });
                if (!data || !data.length) {
                    throw new Error(`Ranged read returned nothing mid-copy. Reading ${JSON.stringify(path)} from ${from.getDebugName()} returned ${data && data.length || "nothing"} at ${offset}-${end} (expected ${end - offset} bytes of a ${totalSize} byte file - it changed or vanished mid-copy)`);
                }
                offset += data.length;
                return data;
            },
        });
        copiedSize = totalSize;
    }
    // Every backend drops a superseded write SILENTLY (its only-take-latest is the last line of defense against races the up-front check can't see), so a returned set is not proof the copy landed - only the destination reporting the file at OUR time or newer is. Newer also counts as landed: the destination is at least as new as what we pushed (and b2 always stamps its own, later, upload time).
    let confirmed = await to.getInfo(toPath, { noFallbacks: config.noFallbacks });
    if (!confirmed || Math.floor(confirmed.writeTime) < Math.floor(writeTime)) {
        logStorageError(`Copy was silently dropped by the destination. Copy of ${JSON.stringify(path)} from ${from.getDebugName()} to ${to.getDebugName()}${toPath !== path && ` (as ${JSON.stringify(toPath)})` || ""}: our copy was ${copiedSize} bytes at ${formatDateTimeDetailed(writeTime)}, but the destination reports ${confirmed && `${confirmed.size} bytes at ${formatDateTimeDetailed(confirmed.writeTime)}` || "nothing"} (a newer write or deletion won the race)`);
        return undefined;
    }
    return { writeTime, size: copiedSize };
}

/**
 * Moves one file - between two archives, or between two paths of one. When from and to are the SAME
 * archives instance and it implements move, the backend moves the file itself (backblaze copies
 * server-side, disk renames, the storage server relocates it node-side) and the bytes never travel
 * through us. Everything else is the safe fallback: copy, then CONFIRM the destination actually
 * reports the file (getInfo), and only then delete the source - the one order in which no failure
 * can lose the file, only at worst leave it in both places. Throws when the source doesn't have the
 * file, or when the copy cannot be confirmed (the source is then left untouched).
 */
export async function moveArchiveFile(config: {
    from: IArchives;
    to: IArchives;
    path: string;
    /** The path at the destination - defaults to path (moving between two archives). Required in practice when from and to are the same archives, where the same path would be a no-op. */
    toPath?: string;
    noFallbacks?: boolean;
}): Promise<void> {
    let { from, to, path } = config;
    let toPath = config.toPath || path;
    if (from === to) {
        if (path === toPath) return;
        if (from.move) {
            await from.move({ fromPath: path, toPath });
            return;
        }
    }
    let copied = await copyArchiveFile({ from, to, path, toPath, noFallbacks: config.noFallbacks });
    if (!copied) {
        // Undefined is two cases (see copyArchiveFile) - asking the source which one keeps the error honest
        let sourceInfo = await from.getInfo(path, { noFallbacks: config.noFallbacks });
        if (sourceInfo) {
            throw new Error(`Move refused - a newer file exists at the destination. Cannot move ${JSON.stringify(path)} (${sourceInfo.size} bytes at ${formatDateTimeDetailed(sourceInfo.writeTime)}) from ${from.getDebugName()}: ${to.getDebugName()} holds something newer at ${JSON.stringify(toPath)}, and the copy was refused rather than roll it back - the source is left untouched`);
        }
        throw new Error(`Move source does not exist. Cannot move ${JSON.stringify(path)}: ${from.getDebugName()} does not have it`);
    }
    let confirmed = await to.getInfo(toPath, { noFallbacks: config.noFallbacks });
    if (!confirmed) {
        throw new Error(`Move copy could not be confirmed - the source is kept. Not deleting ${JSON.stringify(path)} from ${from.getDebugName()} after copying it: ${to.getDebugName()} does not report ${JSON.stringify(toPath)} (the copy claimed to succeed, so something is wrong)`);
    }
    await from.del(path);
}
