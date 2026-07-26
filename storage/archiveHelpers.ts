// Type-only: IArchives.ts re-exports our functions, so a value import back at it would be a require cycle
import type { IArchives } from "./IArchives";

// Cross-archive file operations built ON TOP of IArchives (copy, move) - helpers over the interface, not part of it, so they live beside it rather than in it.

const LARGE_COPY_THRESHOLD = 64 * 1024 * 1024;
const LARGE_COPY_CHUNK = 32 * 1024 * 1024;

/** Copies one file between two archives. Small files go as a single get2+set; past LARGE_COPY_THRESHOLD the copy streams through setLargeFile in LARGE_COPY_CHUNK ranged reads, so the whole file is never in memory. Returns the copied file's info, or undefined when the source doesn't have the file. */
export async function copyArchiveFile(config: {
    from: IArchives;
    to: IArchives;
    path: string;
    /** The path at the destination - defaults to path (the common case: the same key moving between two archives). */
    toPath?: string;
    // From the caller's metadata scan; getInfo fills it in when omitted
    size?: number;
    /** Stamps the destination write with this time INSTEAD of now - which makes the copy lose (silently) to anything newer at the destination, tombstones included. That is exactly right for synchronization, which copies the same key between replicas and must preserve its ordering, and exactly wrong for anything else - so omit it unless the destination is another copy of the same key. */
    writeTime?: number;
    forceSetImmutable?: boolean;
    noChecks?: boolean;
    internal?: boolean;
    noFallbacks?: boolean;
}): Promise<{ writeTime: number; size: number } | undefined> {
    let { from, to, path } = config;
    let toPath = config.toPath || path;
    let size = config.size;
    if (size === undefined) {
        let info = await from.getInfo(path, { noFallbacks: config.noFallbacks });
        if (!info) return undefined;
        size = info.size;
    }
    // Preserving the source's stamp is ONLY for synchronization (copies of the same key between replicas, where the original ordering must survive propagation) - those callers pass writeTime explicitly. A plain copy is a NEW write and is stamped now: stamping it with the source's old time makes it LOSE to any newer write or tombstone at the destination, silently - move a file back to a folder it was deleted from and the copy is dropped, then the caller deletes the source, and the file is gone entirely.
    let writeTime = config.writeTime || Date.now();
    if (size <= LARGE_COPY_THRESHOLD) {
        let result = await from.get2(path, { internal: config.internal, noFallbacks: config.noFallbacks });
        // Empty counts as absent, never as content to copy: an empty file IS a deletion, set refuses empty buffers, and deletions travel through their own path (del / scan tombstones)
        if (!result || !result.data || !result.data.length) return undefined;
        await to.set(toPath, result.data, { lastModified: writeTime, forceSetImmutable: config.forceSetImmutable, noChecks: config.noChecks, internal: config.internal });
        return { writeTime, size: result.data.length };
    }
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
                throw new Error(`Ranged read of ${JSON.stringify(path)} from ${from.getDebugName()} returned ${data && data.length || "nothing"} at ${offset}-${end} (expected ${end - offset} bytes of a ${totalSize} byte file - it changed or vanished mid-copy)`);
            }
            offset += data.length;
            return data;
        },
    });
    return { writeTime, size: totalSize };
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
        throw new Error(`Cannot move ${JSON.stringify(path)}: ${from.getDebugName()} does not have it`);
    }
    let confirmed = await to.getInfo(toPath, { noFallbacks: config.noFallbacks });
    if (!confirmed) {
        throw new Error(`Not deleting ${JSON.stringify(path)} from ${from.getDebugName()} after copying it: ${to.getDebugName()} does not report ${JSON.stringify(toPath)} (the copy claimed to succeed, so something is wrong - the file is left at the source)`);
    }
    await from.del(path);
}
