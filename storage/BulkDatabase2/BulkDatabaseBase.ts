import { sort } from "socket-function/src/misc";
import { getTimeUnique } from "socket-function/src/bits";
import { ABSENT, BaseBulkDatabaseReader, buildFileBuffer, BulkHeaderInfo, EMPTY_BUFFER, KEY_COLUMN, loadBulkDatabase, loadBulkHeader, TARGET_FILE_BYTES } from "./BulkDatabaseFormat";
import { lazy } from "socket-function/src/caching";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { blue, red } from "socket-function/src/formatting/logColors";
import { blockCache, encodeCompressedBlocks, GetRange } from "./blockCache";
import { STREAM_EXTENSION, StreamEntry, frameRows, frameDeletes, parseStream, streamReaderFromEntries } from "./streamLog";
import { connect as syncConnect, broadcast as syncBroadcast, broadcastSeal as syncBroadcastSeal, isSyncSupported, RemoteWrite } from "./syncClient";
import { tryAcquireMergeLock, releaseMergeLock } from "./mergeLock";
import type { FileStorage } from "../FileFolderAPI";

// ───────────────────────────────────────────────────────────────────────────────────────────────
// KNOWN BUGS (accepted, documented):
//
//  • Inconsistent directory listing under concurrent merges. A read lists the directory, then loads
//    each listed file. If a file is missing when we go to read it (a merge deleted it), we re-list and
//    retry — the deleting merge wrote the replacement first, so the data is never gone, just moved.
//    But a directory listing is not guaranteed atomic on every filesystem: a listing taken while
//    another writer is mid-swap can in principle return a set of files that never simultaneously
//    existed (e.g. the replacement but not a sibling it depends on). That yields a momentarily
//    INCONSISTENT view — some keys may read stale or missing. It does NOT lose data on disk: a reload
//    (refresh the page) re-lists and resolves correctly. We accept this rather than reintroduce a
//    manifest; it's rare and OS/filesystem-dependent.
// ───────────────────────────────────────────────────────────────────────────────────────────────

// BulkDatabase2's compressed-block format is not compatible with BulkDatabase, so it uses its own
// folder rather than sharing bulkDatabases/.
const BULK_ROOT_FOLDER = "bulkDatabases2";
const FILE_EXTENSION = ".bulk";
// A single writeBatch that already exceeds these limits skips the tier-0 stream and folds straight
// into a bulk file (streaming thousands of rows one frame at a time would be pointless).
const ROLLOVER_ROWS = 5000;
const ROLLOVER_BYTES = 5 * 1024 * 1024;

// An unreadable (corrupt/torn, not merely missing) file might be a write still in progress, so we
// can't delete it on sight. Once it's been unreadable for longer than this (by its name timestamp),
// no writer is plausibly still working on it, so we delete it. Until then we just warn.
const STALE_DELETE_MS = 24 * 60 * 60 * 1000;

// A read lists the directory then loads each file; if a file vanished (a merge deleted it) we re-list
// and retry, since the merge wrote the replacement first. Bounded so a pathological merge storm can't
// loop forever — after this many tries we load whatever's currently there (the documented inconsistent
// -view bug), which a later reload resolves.
const MAX_READ_ATTEMPTS = 8;

// The first ("consolidate recent") merge accumulates the newest files up to this many bytes into one
// file (half the target, so it has room to grow before it needs splitting). The key-stratified second
// merge groups keys into runs of this many bytes and only rewrites a group whose fraction of duplicate
// (multi-file) keys exceeds DUP_THRESHOLD — i.e. only when deduping actually buys enough.
const FIRST_MERGE_BYTES = TARGET_FILE_BYTES / 2;
const KEY_GROUP_BYTES = 800 * 1024 * 1024;
const DUP_THRESHOLD = 0.4;

// Time thresholds, mutable so tests can shrink them from hours to milliseconds.
export const bulkDatabase2Timing = {
    // A writer stops appending to its current stream file once it's this old (starts a fresh one). A
    // stream file older than this is therefore safe for a merge to delete: its writer has provably moved
    // on to a new file and will never append to it again.
    streamSealAgeMs: 10 * 60 * 60 * 1000,
    // Per-instance throttle: a write triggers at most one background testMerge scan per this interval.
    mergeCheckIntervalMs: 30 * 60 * 1000,
    // The first merge fires when the recent (up to FIRST_MERGE_BYTES) files number more than this...
    firstMergeTriggerFiles: 20,
    // ...or span a wider write-time range than this (data trickling in slowly still gets consolidated).
    firstMergeTriggerRangeMs: 3 * 24 * 60 * 60 * 1000,
};

// Marks a key as deleted in the in-memory overlay.
const DELETED = Symbol("deleted");
// Each overlay entry carries the write's unique timestamp so cross-tab writes can be ordered: a
// remote write only overrides a key if it's newer than what we already have.
type OverlayEntry = { time: number; value: Record<string, unknown> | typeof DELETED };

// Composite cache/signal keys join two arbitrary strings with a NUL separator (which can't occur in
// the inputs). NUL is built from a char code so an actual NUL byte never appears in this source file
// (which would otherwise make tools treat it as binary).
const NULL = String.fromCharCode(0);
function nullJoin(a: string, b: string): string {
    return a + NULL + b;
}

// A tiny reactivity seam so this file has zero dependency on mobx (or any specific UI framework). The
// reactive in-memory state (the overlay map + the load/reset lifecycle) is plain; whenever it's read
// we "observe" a signal, and whenever it changes we "invalidate" that signal. A consumer that wants
// reactivity (e.g. the mobx subclass) supplies a ReactiveDeps that maps each signal string onto its
// own framework's dependency tracking; a consumer that doesn't can pass noopReactiveDeps.
export interface ReactiveDeps {
    // Register `signal` as a dependency of whatever reactive context is currently reading.
    observe(signal: string): void;
    // Notify any context that observed `signal` that it changed.
    invalidate(signal: string): void;
    // Run a group of mutations + invalidations as one batch, so observers re-run at most once.
    batch(fn: () => void): void;
}

// A non-reactive ReactiveDeps: sync reads still return current values, they just never trigger
// re-renders. Use this when you don't need a UI to react to writes.
export const noopReactiveDeps: ReactiveDeps = {
    observe() { },
    invalidate() { },
    batch(fn) { fn(); },
};

// Provides the FileStorage for a given path (the caller decides where data physically lives, so this
// file needn't know about getFileStorageNested2 / the browser-vs-node storage details).
export type StorageFactory = (path: string) => Promise<FileStorage>;

// The load/reset lifecycle shares one signal; every sync read observes it so it re-renders when the
// reader resets or a base column/field finishes loading. The overlay's per-key signal is the key
// itself (a point read observes just its key), plus one overlay-wide signal that whole-column reads
// observe so they recompute on any overlay change. The NUL prefix keeps the two special signals
// from ever colliding with a real data key.
const LOAD_SIGNAL = NULL + "load";
const OVERLAY_SIGNAL = NULL + "overlay";

let fileNameCounter = 0;
// Random per-process id baked into file names so two processes (tabs) writing the same collection
// never collide on a name when they pick the same timestamp/counter in the same millisecond.
const writerId = Math.random().toString(36).slice(2, 10);
function nextCounter(): number {
    return ++fileNameCounter;
}

type BulkFileInfo = { fileName: string; level: number; timestamp: number };

let lastFileTime = 0;
// A strictly-increasing integer timestamp for newly written files, so the newest-first order is
// unambiguous even when several writes land in the same millisecond. (getTimeUnique isn't used here
// because it may return a fractional value, which wouldn't round-trip through the integer file name.)
function nextFileTime(): number {
    lastFileTime = Math.max(Date.now(), lastFileTime + 1);
    return lastFileTime;
}

// Files are ordered purely by timestamp (newest-first). A merged file is given the newest timestamp
// of the run it replaced, so it occupies exactly that run's slot. The leading "0" is a vestigial
// field kept so the name stays in the historical level_timestamp_..._counter shape parseFileName reads.
function newFileName(timestamp: number): string {
    return `0_${timestamp}_${writerId}_${nextCounter()}${FILE_EXTENSION}`;
}

type StreamFileInfo = { fileName: string; timestamp: number };

function parseStreamFileName(fileName: string): StreamFileInfo | undefined {
    if (!fileName.endsWith(STREAM_EXTENSION)) return undefined;
    const parts = fileName.slice(0, -STREAM_EXTENSION.length).split("_");
    // stream_<timestamp>_<random>
    if (parts.length !== 3 || parts[0] !== "stream") return undefined;
    const timestamp = parseInt(parts[1], 10);
    if (!Number.isFinite(timestamp)) return undefined;
    return { fileName, timestamp };
}

function parseFileName(fileName: string): BulkFileInfo | undefined {
    if (!fileName.endsWith(FILE_EXTENSION)) return undefined;
    const parts = fileName.slice(0, -FILE_EXTENSION.length).split("_");
    // Accept both the old 3-part (level_timestamp_counter) and new 4-part
    // (level_timestamp_writerId_counter) shapes; level + timestamp are always the first two fields.
    if (parts.length < 3) return undefined;
    const level = parseInt(parts[0], 10);
    const timestamp = parseInt(parts[1], 10);
    if (!Number.isFinite(level) || !Number.isFinite(timestamp)) return undefined;
    return { fileName, level, timestamp };
}

// A file we listed is gone now (a concurrent merge deleted it after writing its replacement). Distinct
// from a corrupt/torn file: missing => the data moved, so re-list and retry; corrupt => skip the file.
class MissingFileError extends Error { }
// Thrown out of a read build when a listed file went missing mid-load, so the build re-lists and retries.
class FilesChangedError extends Error { }

// All of BulkDatabase2's behavior, with no dependency on mobx or on a particular storage backend.
// Reactivity is delegated to the injected ReactiveDeps and storage to the injected StorageFactory.
export class BulkDatabaseBase<T extends { key: string }> {
    constructor(
        public readonly name: string,
        protected deps: ReactiveDeps,
        private storageFactory: StorageFactory,
    ) { }

    // Block range cache is global and immutable-file-safe; clear it to simulate a cold page load
    // (e.g. between an untimed prep step and the timed benchmark).
    public static clearCache() {
        blockCache.clear();
    }

    public storage = lazy(async () => this.storageFactory(`${BULK_ROOT_FOLDER}/${this.name}`));

    // In-memory overlay of pending writes/deletes. It takes priority over the loaded readers, so writes
    // are reflected in reads without reloading. Reads observe the relevant signal; mutations invalidate it.
    //
    // NOTE: we never bound or clear this in-memory state during normal operation (only on a structural
    // rollover/reset, where the data has been persisted into bulk files). The whole database must be
    // resident in memory anyway — file merging reads every row — so a database large enough to blow
    // the in-memory cache would already fail at merge time. There is no partial-load mode.
    private overlay = new Map<string, OverlayEntry>();
    // Latest stream-on-disk timestamp per key (from the loaded stream files). Used together with the
    // overlay to decide whether an incoming remote write is actually newer than what we have.
    private streamTimes = new Map<string, number>();

    // This instance's tier-0 stream file. Each instance (≈ each thread/tab) streams to its own file
    // so concurrent writers never touch the same file.
    private streamFileName: string | undefined;
    // Seeded to construction time (not 0) so a fresh instance doesn't immediately seal+merge on its very
    // first write — the first background merge check waits a full interval after construction.
    private lastMergeCheck = Date.now();
    private getStreamFileName(): string {
        // Seal (stop appending to) our current file once it's old enough, so no file is ever appended
        // to past the seal age — that's what lets a consolidation safely fold it once it's aged out.
        if (this.streamFileName) {
            const info = parseStreamFileName(this.streamFileName);
            if (info && Date.now() - info.timestamp >= bulkDatabase2Timing.streamSealAgeMs) this.streamFileName = undefined;
        }
        if (!this.streamFileName) {
            this.streamFileName = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${STREAM_EXTENSION}`;
        }
        return this.streamFileName;
    }

    private invalidateOverlay(key: string) {
        this.deps.invalidate(key);
        this.deps.invalidate(OVERLAY_SIGNAL);
    }

    // Merges a (possibly partial) row onto the key's current overlay value, so a partial write/update
    // only changes the columns it includes — the rest fall through to disk on read. A prior delete is
    // reset (the key is being re-created).
    private setOverlayRow(key: string, row: Record<string, unknown>, time: number) {
        const existing = this.overlay.get(key);
        const value = existing && existing.value !== DELETED ? { ...existing.value, ...row } : { ...row };
        this.overlay.set(key, { time, value });
        this.invalidateOverlay(key);
    }

    private setOverlayDeleted(key: string, time: number) {
        this.overlay.set(key, { time, value: DELETED });
        this.invalidateOverlay(key);
    }

    private reader = lazy(async (): Promise<ResolvedReader> => {
        // A merge can delete a file between our directory listing and our read of it. The merge wrote the
        // replacement first, so the data isn't gone — it just moved to a file our stale listing didn't
        // include. So on a missing file we re-list and rebuild. Bounded; the last attempt tolerates a
        // missing file (loads whatever is there — the documented inconsistent-view bug, fixed by reload).
        let start = Date.now();
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.buildReader(start, attempt >= MAX_READ_ATTEMPTS);
            } catch (e) {
                if (e instanceof FilesChangedError && attempt < MAX_READ_ATTEMPTS) continue;
                throw e;
            }
        }
    });

    // One read build over a directory listing. Loads every bulk file's columnar reader plus all streamed
    // entries, then joins them by write-time. A corrupt/torn bulk file is skipped with a warning (its
    // data lives in another file). A *missing* file (deleted by a concurrent merge) throws
    // FilesChangedError so the caller re-lists — unless tolerateMissing, when we proceed without it.
    private async buildReader(start: number, tolerateMissing: boolean): Promise<ResolvedReader> {
        const { bulkFiles, streamFiles } = await this.listFiles();
        let filesChanged = false;
        const [bulkReadersRaw, streamData] = await Promise.all([
            Promise.all(bulkFiles.map(async f => {
                try {
                    return await this.loadFileReader(f.fileName);
                } catch (e) {
                    if (e instanceof MissingFileError) { filesChanged = true; return undefined; }
                    await this.handleUnreadableFile(f, (e as Error).message);
                    return undefined;
                }
            })),
            this.loadStreamEntries(streamFiles),
        ]);
        if (streamData.missing) filesChanged = true;
        if (filesChanged && !tolerateMissing) throw new FilesChangedError();

        const bulkReaders = bulkReadersRaw.filter((r): r is BaseBulkDatabaseReader => !!r);
        // The join resolves purely by write-time, so reader order doesn't matter.
        const readers: BaseBulkDatabaseReader[] = [];
        const ordered = this.orderStreamEntries(streamData.entries);
        if (ordered.length) {
            const stream = streamReaderFromEntries(ordered, streamData.totalBytes);
            readers.push(stream.reader);
            this.streamTimes = stream.times;
        } else {
            this.streamTimes = new Map();
        }
        readers.push(...bulkReaders);
        const joined = await joinBulkDatabases(readers);

        let time = Date.now() - start;
        if (time > 50) {
            console.log(`${blue(`${this.name} loaded`)} in ${red(formatTime(time))} (${blue(formatNumber(joined.rowCount))} rows, ${bulkFiles.length} bulk + ${streamFiles.length} stream files)`);
        }
        return joined;
    }

    // Connects to the cross-tab BroadcastChannel (browser only) so writes in other tabs of this
    // collection update our overlay. Runs once; no-op in Node / where BroadcastChannel is unavailable.
    // We wait for the reader (and thus streamTimes) first so conflict resolution can see disk
    // timestamps, then peers reply to our hello with recent writes that may not be on disk yet (applied
    // through the same applyRemote callback).
    private syncSetup = lazy(async () => {
        if (!isSyncSupported()) return;
        await this.reader();
        // onSeal: a peer is about to fold recent data; drop our current stream file so we stop appending
        // to it (our next write starts a fresh one), letting the merge fold it whole.
        let recent = await syncConnect(this.name, write => this.applyRemote(write), () => { this.streamFileName = undefined; });
        for (let write of recent) this.applyRemote(write);
    });

    // The timestamp of the value we currently hold for a key (overlay first, then disk stream).
    private localTime(key: string): number {
        let entry = this.overlay.get(key);
        if (entry) return entry.time;
        let streamTime = this.streamTimes.get(key);
        if (streamTime !== undefined) return streamTime;
        return -Infinity;
    }

    // Applies a write received from another tab. Only takes effect if it's newer than what we have,
    // so it never clobbers our own (or disk's) more recent write for the same key.
    private applyRemote(write: RemoteWrite) {
        if (write.time <= this.localTime(write.key)) return;
        this.deps.batch(() => {
            if (write.deleted) this.setOverlayDeleted(write.key, write.time);
            else this.setOverlayRow(write.key, write.value as Record<string, unknown>, write.time);
        });
    }

    // Reset the loaded reader and all derived in-memory caches/overlay. Used only on structural
    // changes (large direct-bulk write, rollover, compact) after the data has been persisted.
    private resetReader() {
        this.deps.batch(() => {
            this.reader.reset();
            this.baseColumns.clear();
            this.baseColumnsLoading.clear();
            this.baseFields.clear();
            this.baseFieldsLoading.clear();
            this.overlay.clear();
            this.deps.invalidate(LOAD_SIGNAL);
            this.deps.invalidate(OVERLAY_SIGNAL);
        });
    }

    // ---- writes ----

    public async write(entry: T): Promise<void> {
        return this.writeBatch([entry]);
    }

    public async writeBatch(entries: T[]): Promise<void> {
        if (!entries.length) return;
        void this.syncSetup();
        const rows = entries as unknown as Record<string, unknown>[];
        // Stamp each row with a unique timestamp now, so the same time is used on disk, in the overlay,
        // and in the cross-tab broadcast.
        const stamped = rows.map(row => ({ time: getTimeUnique(), row }));
        const framed = frameRows(stamped);

        // A batch that already exceeds the limits skips the tier-0 stream and writes a bulk file directly
        // (streaming thousands of rows one frame at a time would be pointless).
        if (entries.length >= ROLLOVER_ROWS || framed.length >= ROLLOVER_BYTES) {
            await this.writeBulkFile(rows);
            return;
        }

        // Otherwise append to this thread's stream file (one cheap append) and reflect it in the
        // overlay immediately — no reader reset.
        const storage = await this.storage();
        await storage.append(this.getStreamFileName(), framed);
        this.deps.batch(() => {
            for (const { time, row } of stamped) this.setOverlayRow(row.key as string, row, time);
        });
        for (const { time, row } of stamped) syncBroadcast(this.name, { key: row.key as string, time, value: row });
        void this.maybeMerge();
    }

    public async delete(key: string): Promise<void> {
        return this.deleteBatch([key]);
    }

    public async deleteBatch(keys: string[]): Promise<void> {
        if (!keys.length) return;
        void this.syncSetup();
        const stamped = keys.map(key => ({ time: getTimeUnique(), key }));
        const storage = await this.storage();
        await storage.append(this.getStreamFileName(), frameDeletes(stamped));
        this.deps.batch(() => {
            for (const { time, key } of stamped) this.setOverlayDeleted(key, time);
        });
        for (const { time, key } of stamped) syncBroadcast(this.name, { key, time, deleted: true });
        void this.maybeMerge();
    }

    public async update(entry: Partial<T> & { key: string }): Promise<void> {
        return this.updateBatch([entry]);
    }

    // Like writeBatch, but each entry is a partial row — only the fields to change, plus the required
    // key. Partial fields merge onto the existing row (unset columns fall through to the current value);
    // an entry whose key isn't in the collection is skipped with a warning, since update never creates keys.
    public async updateBatch(entries: (Partial<T> & { key: string })[]): Promise<void> {
        if (!entries.length) return;
        void this.syncSetup();
        const reader = await this.reader();
        const diskKeys = new Set(reader.keys);
        const present: T[] = [];
        for (const entry of entries) {
            const overlayEntry = this.overlay.get(entry.key);
            const exists = overlayEntry ? overlayEntry.value !== DELETED : diskKeys.has(entry.key);
            if (!exists) {
                console.warn(`${this.name}.update: key ${JSON.stringify(entry.key)} is not in the collection, ignoring`);
                continue;
            }
            present.push(entry as unknown as T);
        }
        if (present.length) await this.writeBatch(present);
    }

    // Lists every bulk + stream file currently on disk (no manifest — every file is part of the
    // database). Bulk newest-first, streams oldest-first. Duplicate data (from a crashed/raced merge)
    // is harmless: reads resolve by write-time and a later merge with enough duplication removes it.
    private async listFiles(): Promise<{ bulkFiles: BulkFileInfo[]; streamFiles: StreamFileInfo[] }> {
        const storage = await this.storage();
        const names = await storage.getKeys();
        const bulkFiles: BulkFileInfo[] = [];
        const streamFiles: StreamFileInfo[] = [];
        for (const n of names) {
            if (n.endsWith(FILE_EXTENSION)) { const p = parseFileName(n); if (p) bulkFiles.push(p); }
            else if (n.endsWith(STREAM_EXTENSION)) { const p = parseStreamFileName(n); if (p) streamFiles.push(p); }
        }
        // Newest-first by timestamp; ties broken by file name for determinism.
        bulkFiles.sort((a, b) => {
            if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
            return a.fileName < b.fileName && 1 || a.fileName > b.fileName && -1 || 0;
        });
        sort(streamFiles, f => f.timestamp);
        return { bulkFiles, streamFiles };
    }

    // Writes `rows` directly as bulk file(s), stamped with the current time as their write-time (the rows
    // are being written now). Used by the large-batch write path: no manifest, just new files on disk.
    // The rows carry time=now, so the join orders them correctly against any older stream entry for the
    // same key (newer time wins) — no clobber. A later testMerge consolidates them.
    private async writeBulkFile(rows: Record<string, unknown>[]): Promise<void> {
        const storage = await this.storage();
        const timestamp = nextFileTime();
        const now = Date.now();
        const times = rows.map(() => now);
        for (const buffer of buildFileBuffer(rows, times)) {
            const name = newFileName(timestamp);
            await storage.set(name, encodeCompressedBlocks(buffer));
        }
        this.resetReader();
        void this.maybeMerge();
    }

    // Reads and parses every stream file in parallel. Returns per-write entries (each carrying its
    // unique timestamp + originating file) so callers can order writes globally across files, the
    // prefix size we read per file (so a merge can verify nothing was appended before deleting it), and
    // whether any listed file was missing (so a read can re-list and retry — a merge deleted it).
    private async loadStreamEntries(streamFiles: StreamFileInfo[]): Promise<{ entries: { time: number; fileName: string; entry: StreamEntry }[]; totalBytes: number; missing: boolean; sizes: Map<string, number> }> {
        const sizes = new Map<string, number>();
        if (!streamFiles.length) return { entries: [], totalBytes: 0, missing: false, sizes };
        const storage = await this.storage();
        let missing = false;
        // Read a bounded prefix [0, size) rather than the whole file: a foreign writer may be appending
        // concurrently, and storage.get() errors when the file grows past the size it stat'd. Reading a
        // prefix is tolerant — parseStream stops at the last complete frame, the file stays valid, and a
        // later read picks up the rest. A file removed out from under us (a merge) sets `missing`.
        const buffers = await Promise.all(streamFiles.map(async f => {
            try {
                const info = await storage.getInfo(f.fileName);
                if (!info) { missing = true; return undefined; }
                sizes.set(f.fileName, info.size);
                if (info.size === 0) return undefined;
                return await storage.getRange(f.fileName, { start: 0, end: info.size });
            } catch {
                missing = true;
                return undefined;
            }
        }));
        const entries: { time: number; fileName: string; entry: StreamEntry }[] = [];
        let totalBytes = 0;
        for (let i = 0; i < streamFiles.length; i++) {
            const buffer = buffers[i];
            if (!buffer) continue;
            totalBytes += buffer.length;
            const parsed = parseStream(buffer);
            if (parsed.badBytes > 0) {
                console.warn(`${this.name} stream file ${streamFiles[i].fileName} had ${parsed.badBytes} trailing bad/incomplete bytes (stopped reading there)`);
            }
            for (const entry of parsed.entries) {
                entries.push({ time: entry.time, fileName: streamFiles[i].fileName, entry });
            }
        }
        return { entries, totalBytes, missing, sizes };
    }

    // Global mutation order across per-thread files: by unique timestamp, ties broken by file name.
    private orderStreamEntries(entries: { time: number; fileName: string; entry: StreamEntry }[]): StreamEntry[] {
        entries.sort((a, b) => {
            if (a.time !== b.time) return a.time - b.time;
            return a.fileName < b.fileName && -1 || a.fileName > b.fileName && 1 || 0;
        });
        return entries.map(e => e.entry);
    }

    // Throttled, fire-and-forget after writes: run a background merge check at most once per interval.
    private async maybeMerge(): Promise<void> {
        const now = Date.now();
        if (now - this.lastMergeCheck < bulkDatabase2Timing.mergeCheckIntervalMs) return;
        this.lastMergeCheck = now;
        try {
            await this.tryMergeNow();
        } catch (e) {
            console.warn(`${this.name}: background merge failed: ${(e as Error).message}`);
        }
    }

    // Runs one merge pass now (the same one maybeMerge runs on a timer). Returns whether it merged
    // anything, and whether it bailed because another tab/process holds the merge lock — so a caller
    // (e.g. a 30-minute scheduler) can tell "nothing to do" from "someone else is doing it".
    public async tryMergeNow(): Promise<{ merged: boolean; lockFailed: boolean }> {
        if (!tryAcquireMergeLock(this.name, writerId)) return { merged: false, lockFailed: true };
        try {
            return { merged: await this.testMerge(), lockFailed: false };
        } finally {
            releaseMergeLock(this.name, writerId);
        }
    }

    // Full compaction: fold + dedup everything into key-sorted, ~256MB files. Reads the whole collection
    // into memory (the accepted soft bound), so it's an explicit, occasional call. Deletes consumed bulk
    // files and any stream file it's safe to (aged, or sealed-and-stable).
    public async compact(): Promise<void> {
        if (!tryAcquireMergeLock(this.name, writerId)) return; // someone else is already merging; fine
        try {
            syncBroadcastSeal(this.name);
            this.streamFileName = undefined;
            const { bulkFiles, streamFiles } = await this.listFiles();
            if (bulkFiles.length + streamFiles.length >= 1) await this.mergeFileSet(bulkFiles, streamFiles);
        } finally {
            releaseMergeLock(this.name, writerId);
        }
    }

    // The unified merge entry point: rewrite everything overlapping [timeLo, timeHi] into fresh
    // key-sorted ~256MB bulk file(s). Selects bulk files by their header time range and stream files by
    // their (creation .. seal-age) window. If the range reaches the present, first asks peers to seal so
    // recent stream data is complete. Callers: testMerge (recent / key-group ranges); external callers
    // can pass any range — older data just produces older files.
    public async merge(timeLo: number, timeHi: number): Promise<void> {
        if (timeHi >= Date.now()) { syncBroadcastSeal(this.name); this.streamFileName = undefined; }
        const { bulkFiles, streamFiles } = await this.listFiles();
        const headers = await Promise.all(bulkFiles.map(f => this.readBulkHeader(f.fileName)));
        const selBulk = bulkFiles.filter((f, i) => {
            const h = headers[i];
            if (!h) return false;
            // Old files (no recorded time range) only belong to a merge that reaches back to the start.
            if (!h.maxTime && !h.minTime) return timeLo <= 0;
            return h.minTime <= timeHi && h.maxTime >= timeLo;
        });
        const selStream = streamFiles.filter(f =>
            f.timestamp <= timeHi && f.timestamp + bulkDatabase2Timing.streamSealAgeMs >= timeLo);
        if (selBulk.length + selStream.length < 2) return;
        await this.mergeFileSet(selBulk, selStream);
    }

    // Throws MissingFileError (not a generic error) when the file is gone, so callers can distinguish a
    // file a merge deleted (re-list and retry / skip) from a corrupt one (handle as unreadable).
    private async makeRawGetRange(fileName: string): Promise<{ rawGetRange: GetRange; size: number }> {
        const storage = await this.storage();
        const info = await storage.getInfo(fileName);
        if (!info) throw new MissingFileError(`bulk file ${fileName} is missing`);
        const rawGetRange: GetRange = async (start, end) => {
            if (end <= start) return EMPTY_BUFFER;
            const buf = await storage.getRange(fileName, { start, end });
            if (!buf) throw new MissingFileError(`range [${start}, ${end}) of ${fileName} is missing`);
            return buf;
        };
        return { rawGetRange, size: info.size };
    }

    private async loadFileReader(fileName: string): Promise<BaseBulkDatabaseReader> {
        const raw = await this.makeRawGetRange(fileName);
        const fileId = nullJoin(this.name, fileName);
        // Files are immutable and stored as compressed blocks; replace getRange with a block-cached,
        // decompressing version (same interface) and read the logical (uncompressed) size from its
        // index. open() validates the file size against the index and throws if it's truncated/corrupt.
        const opened = await blockCache.open(fileId, raw.size, raw.rawGetRange);
        return loadBulkDatabase({ totalBytes: opened.uncompressedSize, getRange: opened.getRange });
    }

    // Reads only a bulk file's header (row count, time range, key range) — no column data — for merge
    // planning. Returns undefined for a missing/corrupt file so the planner just leaves it out.
    private async readBulkHeader(fileName: string): Promise<BulkHeaderInfo | undefined> {
        try {
            const raw = await this.makeRawGetRange(fileName);
            const fileId = nullJoin(this.name, fileName);
            const opened = await blockCache.open(fileId, raw.size, raw.rawGetRange);
            return await loadBulkHeader(opened.getRange, opened.uncompressedSize);
        } catch {
            return undefined;
        }
    }

    // Logical (uncompressed) size of a bulk file, read from its (cached) index without loading data.
    // Used by the merge planner to bound how much it reads at once. Returns undefined for a file that's
    // missing or unreadable so the planner simply leaves it out of any merge.
    private async fileLogicalSize(fileName: string): Promise<number | undefined> {
        try {
            const raw = await this.makeRawGetRange(fileName);
            const fileId = nullJoin(this.name, fileName);
            const opened = await blockCache.open(fileId, raw.size, raw.rawGetRange);
            return opened.uncompressedSize;
        } catch {
            return undefined;
        }
    }

    // A bulk file that won't load is either a write still in progress (recent) or a stale partial write
    // left by a crash. We can't tell which from the bytes, so we go by age: warn while it's young
    // enough that a writer could still be finishing it, and delete it once it's clearly abandoned.
    // Deleting is safe — the write protocol always writes a new file before removing the files it
    // supersedes, so an abandoned partial file's data still lives in another (older) file.
    private async handleUnreadableFile(file: BulkFileInfo, message: string): Promise<void> {
        let ageMs = Date.now() - file.timestamp;
        if (ageMs > STALE_DELETE_MS) {
            console.warn(`${this.name}: deleting stale unreadable bulk file ${file.fileName} (${Math.round(ageMs / 86400000)}d old): ${message}`);
            try {
                let storage = await this.storage();
                await storage.remove(file.fileName);
            } catch (removeError) {
                console.warn(`${this.name}: failed to delete ${file.fileName}: ${(removeError as Error).message}`);
            }
            return;
        }
        console.warn(`${this.name}: skipping unreadable bulk file ${file.fileName} (recent — may be an in-progress write): ${message}`);
    }

    // Resolves a set of readers (stream + bulk) by ACTUAL write-time into merged rows + per-row times,
    // plus the surviving tombstones (keys whose newest event is a delete). For each key/column, the
    // value with the newest write-time across readers wins (non-ABSENT); the row's time is the newest of
    // those. A key is deleted iff its newest delete is newer than its newest set. This is the same
    // time-resolution reads use, captured so a merge can write the result back as bulk + a carry stream.
    private async resolveReaders(readers: BaseBulkDatabaseReader[]): Promise<{ rows: Record<string, unknown>[]; times: number[]; deletes: Map<string, number> }> {
        const loaded = await Promise.all(readers.map(async reader => {
            const cols = new Map<string, Map<string, { value: unknown; time: number }>>();
            for (const col of reader.columns) {
                if (col.column === KEY_COLUMN) continue;
                const entries = await reader.getColumn(col.column);
                cols.set(col.column, new Map(entries.map(e => [e.key, { value: e.value, time: e.time }])));
            }
            return { keyTimes: reader.keyTimes, deleteTimes: reader.deleteTimes, cols };
        }));

        const deleteTime = new Map<string, number>();
        for (const l of loaded) {
            if (!l.deleteTimes) continue;
            for (const [k, t] of l.deleteTimes) deleteTime.set(k, Math.max(deleteTime.get(k) ?? -Infinity, t));
        }
        const keyTime = new Map<string, number>();
        for (const l of loaded) {
            for (const [k, t] of l.keyTimes) keyTime.set(k, Math.max(keyTime.get(k) ?? -Infinity, t));
        }
        const allCols = new Set<string>();
        for (const l of loaded) for (const c of l.cols.keys()) allCols.add(c);

        const rows: Record<string, unknown>[] = [];
        const times: number[] = [];
        const deletes = new Map<string, number>();
        const allKeys = new Set<string>([...keyTime.keys(), ...deleteTime.keys()]);
        for (const key of allKeys) {
            const setT = keyTime.get(key) ?? -Infinity;
            const delT = deleteTime.get(key) ?? -Infinity;
            if (setT <= delT) {
                // The newest event for this key is a delete — carry the tombstone forward so it keeps
                // suppressing any older set living in a file outside this merge.
                if (delT > -Infinity) deletes.set(key, delT);
                continue;
            }
            const row: Record<string, unknown> = { [KEY_COLUMN]: key };
            let rowTime = setT;
            for (const col of allCols) {
                let bestTime = -Infinity;
                let bestVal: unknown;
                let found = false;
                for (const l of loaded) {
                    const cell = l.cols.get(col)?.get(key);
                    if (!cell || cell.value === ABSENT) continue;
                    if (cell.time > bestTime) { bestTime = cell.time; bestVal = cell.value; found = true; }
                }
                if (found) { row[col] = bestVal; if (bestTime > rowTime) rowTime = bestTime; }
            }
            rows.push(row);
            times.push(rowTime === -Infinity ? 0 : rowTime);
        }
        return { rows, times, deletes };
    }

    // The one merge primitive. Reads the given bulk + stream files (skipping any that vanished or won't
    // parse — their data lives elsewhere), resolves them by write-time, writes the result back as fresh
    // key-sorted ~256MB bulk file(s) plus a carry stream for surviving tombstones, THEN deletes the
    // inputs it consumed. Output is always written before any delete, so a crash leaves duplicates (next
    // merge removes them), never a gap. A bulk file is deleted only if we actually read it; a stream file
    // only if it's aged out (its writer has switched files) or — when cross-tab sync sealed it — its size
    // didn't change while we read it. Returns whether it produced anything.
    private async mergeFileSet(bulkFiles: BulkFileInfo[], streamFiles: StreamFileInfo[]): Promise<boolean> {
        const storage = await this.storage();
        const timestamp = nextFileTime();
        const now = Date.now();

        const consumedBulk: BulkFileInfo[] = [];
        const bulkReaders: BaseBulkDatabaseReader[] = [];
        await Promise.all(bulkFiles.map(async f => {
            try {
                const r = await this.loadFileReader(f.fileName);
                bulkReaders.push(r);
                consumedBulk.push(f); // only files we actually read are safe to delete afterwards
            } catch { /* missing or corrupt — skip; its data lives in another file */ }
        }));

        const streamData = await this.loadStreamEntries(streamFiles);
        const ordered = this.orderStreamEntries(streamData.entries);
        const streamReader = ordered.length ? streamReaderFromEntries(ordered, 0).reader : undefined;

        const readers = streamReader ? [streamReader, ...bulkReaders] : bulkReaders;
        if (!readers.length) return false;

        const { rows, times, deletes } = await this.resolveReaders(readers);

        // Write all outputs BEFORE deleting any input, so a throw mid-write just leaves duplicates.
        const newNames: string[] = [];
        if (rows.length) {
            for (const buffer of buildFileBuffer(rows, times)) {
                const name = newFileName(timestamp);
                await storage.set(name, encodeCompressedBlocks(buffer));
                newNames.push(name);
            }
        }
        if (deletes.size) {
            const carryName = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${STREAM_EXTENSION}`;
            await storage.set(carryName, frameDeletes([...deletes].map(([key, time]) => ({ time, key }))));
        }

        const remove = async (name: string) => { try { await storage.remove(name); } catch { /* already gone */ } };
        for (const f of consumedBulk) await remove(f.fileName);
        for (const f of streamFiles) {
            if (await this.canDeleteStream(f, now, streamData.sizes)) await remove(f.fileName);
        }

        this.resetReader();
        return newNames.length > 0 || deletes.size > 0;
    }

    // A stream file is safe to delete iff no writer will ever append to it again: it's aged past the seal
    // age (its writer has provably started a fresh file), OR cross-tab sync is active (so the seal we
    // broadcast reached peers) and its size hasn't changed since we read it (nothing was appended during
    // the merge). When neither holds we leave it: its data is now duplicated into bulk (resolved by time)
    // and a later merge deletes it once aged. (Recreate-on-append means even a wrong delete wouldn't lose
    // data, but the aged check also rules out the rare sparse-offset append race.)
    private async canDeleteStream(f: StreamFileInfo, now: number, sizes: Map<string, number>): Promise<boolean> {
        if (now - f.timestamp >= bulkDatabase2Timing.streamSealAgeMs) return true;
        if (!isSyncSupported()) return false;
        const readSize = sizes.get(f.fileName);
        if (readSize === undefined) return false;
        let info;
        try { info = await (await this.storage()).getInfo(f.fileName); } catch { return false; }
        return !!info && info.size === readSize;
    }

    // The merge policy. Up to two passes:
    //  1) Consolidate recent fragmentation: take the newest files up to ~FIRST_MERGE_BYTES and, if they
    //     number more than firstMergeTriggerFiles or span more than firstMergeTriggerRangeMs, merge them
    //     into one file. Seals first so recent stream data is complete; in Node (no cross-tab seal) only
    //     aged streams are folded, so we never re-fold the same un-deletable stream forever.
    //  2) Key-stratify: sort all keys, walk them in ~KEY_GROUP_BYTES groups, and rewrite the single group
    //     whose fraction of duplicate (multi-file) keys is highest above DUP_THRESHOLD — merging every
    //     bulk file overlapping that key range. Over time this sorts the data into key-disjoint files.
    // Returns whether either pass merged anything.
    private async testMerge(): Promise<boolean> {
        let merged = false;

        // ── Pass 1: consolidate recent files. ──
        // Only seal (ask peers + ourselves to abandon current stream files) when cross-tab sync can
        // actually fold recent streams; in Node it would just churn — fragmenting streams every pass for
        // no benefit, since canDeleteStream there only deletes aged files anyway.
        const foldRecentStreams = isSyncSupported(); // see canDeleteStream: else we'd re-fold forever
        if (foldRecentStreams) {
            syncBroadcastSeal(this.name);
            this.streamFileName = undefined; // seal our own current stream so its recent data is complete
        }
        {
            const { bulkFiles, streamFiles } = await this.listFiles();
            const bulkMeta = await Promise.all(bulkFiles.map(async f => {
                const [size, header] = await Promise.all([this.fileLogicalSize(f.fileName), this.readBulkHeader(f.fileName)]);
                return { kind: "bulk" as const, file: f, bytes: size ?? 0, time: header?.maxTime || f.timestamp };
            }));
            const streamMeta: { kind: "stream"; file: StreamFileInfo; bytes: number; time: number }[] = [];
            for (const f of streamFiles) {
                const aged = Date.now() - f.timestamp >= bulkDatabase2Timing.streamSealAgeMs;
                if (!foldRecentStreams && !aged) continue;
                let bytes = 0;
                try { const info = await (await this.storage()).getInfo(f.fileName); bytes = info?.size ?? 0; } catch { bytes = 0; }
                streamMeta.push({ kind: "stream", file: f, bytes, time: f.timestamp });
            }
            const items = [...bulkMeta, ...streamMeta].sort((a, b) => b.time - a.time);
            const recent: typeof items = [];
            let recentBytes = 0;
            for (const it of items) {
                recent.push(it);
                recentBytes += it.bytes;
                if (recentBytes >= FIRST_MERGE_BYTES) break;
            }
            const span = recent.length ? recent[0].time - recent[recent.length - 1].time : 0;
            const triggered = recent.length >= 2
                && (recent.length > bulkDatabase2Timing.firstMergeTriggerFiles || span > bulkDatabase2Timing.firstMergeTriggerRangeMs);
            if (triggered) {
                const rb = recent.filter(i => i.kind === "bulk").map(i => (i.file as BulkFileInfo));
                const rs = recent.filter(i => i.kind === "stream").map(i => (i.file as StreamFileInfo));
                if (await this.mergeFileSet(rb, rs)) merged = true;
            }
        }

        // ── Pass 2: key-stratify the bulk files to remove duplication. ──
        {
            const { bulkFiles } = await this.listFiles();
            if (bulkFiles.length >= 2) {
                const infos = await Promise.all(bulkFiles.map(async f => {
                    try {
                        const reader = await this.loadFileReader(f.fileName);
                        const keys = reader.keys;
                        let min = keys[0], max = keys[0];
                        for (const k of keys) { if (k < min) min = k; if (k > max) max = k; }
                        return { file: f, keys, bytes: reader.totalBytes, min, max };
                    } catch {
                        return { file: f, keys: [] as string[], bytes: 0, min: undefined as string | undefined, max: undefined as string | undefined };
                    }
                }));
                const usable = infos.filter(i => i.keys.length > 0);
                const keyCount = new Map<string, number>();
                let totalSlots = 0, totalBytes = 0;
                for (const i of usable) {
                    totalBytes += i.bytes;
                    for (const k of i.keys) { keyCount.set(k, (keyCount.get(k) || 0) + 1); totalSlots++; }
                }
                if (totalSlots > 0) {
                    const bytesPerSlot = totalBytes / totalSlots;
                    const sortedKeys = [...keyCount.keys()].sort();
                    // Walk sorted keys forming ~KEY_GROUP_BYTES groups; remember the group with the highest
                    // duplicate fraction over the threshold (the most benefit), then merge its files.
                    let best: { lo: string; hi: string; dup: number } | undefined;
                    let gStart = 0, gBytes = 0, gSlots = 0, gUnique = 0;
                    for (let i = 0; i < sortedKeys.length; i++) {
                        const c = keyCount.get(sortedKeys[i])!;
                        gBytes += c * bytesPerSlot; gSlots += c; gUnique += 1;
                        if (gBytes >= KEY_GROUP_BYTES || i === sortedKeys.length - 1) {
                            const dup = (gSlots - gUnique) / gSlots;
                            if (dup > DUP_THRESHOLD && (!best || dup > best.dup)) best = { lo: sortedKeys[gStart], hi: sortedKeys[i], dup };
                            gStart = i + 1; gBytes = 0; gSlots = 0; gUnique = 0;
                        }
                    }
                    if (best) {
                        const lo = best.lo, hi = best.hi;
                        const groupFiles = usable
                            .filter(i => i.min !== undefined && i.max !== undefined && i.min <= hi && i.max >= lo)
                            .map(i => i.file);
                        if (groupFiles.length >= 2 && await this.mergeFileSet(groupFiles, [])) merged = true;
                    }
                }
            }
        }

        return merged;
    }

    private formatInfo(reader: ResolvedReader): string {
        return `(collection has ${blue(formatNumber(reader.rowCount))} rows, ${blue(formatNumber(reader.totalBytes))}B)`;
    }

    // Applies the overlay (pending writes/deletes) on top of a base column. No-op when empty. An
    // overlay entry that doesn't include this column leaves the base (disk) value+time in place — a
    // partial write/update only overrides the columns it set; everything else falls through. An overlay
    // override carries the overlay write's time (when that pending write happened).
    private patchColumn(base: { key: string; value: unknown; time: number }[], column: string): { key: string; value: unknown; time: number }[] {
        if (this.overlay.size === 0) return base;
        const map = new Map(base.map(e => [e.key, { value: e.value, time: e.time }]));
        for (const [key, entry] of this.overlay) {
            if (entry.value === DELETED) { map.delete(key); continue; }
            if (column in entry.value) map.set(key, { value: entry.value[column], time: entry.time });
            else if (!map.has(key)) map.set(key, { value: undefined, time: entry.time });
        }
        return [...map].map(([key, v]) => ({ key, value: v.value, time: v.time }));
    }

    // ---- async reads (overlay-aware) ----

    public async getSingleField<Column extends keyof T>(key: string, column: Column): Promise<T[Column] | undefined> {
        return (await this.getSingleFieldObj(key, column))?.value;
    }

    // Like getSingleField, but returns the same shape a getColumn entry has: { key, value, time }, where
    // time is roughly when that value last changed (the resolved write-time; for a row-merged value it's
    // the newest contributing write). Returns undefined only when the key isn't present/live.
    public async getSingleFieldObj<Column extends keyof T>(key: string, column: Column): Promise<{ key: string; value: T[Column]; time: number } | undefined> {
        void this.syncSetup();
        const col = String(column);
        const entry = this.overlay.get(key);
        if (entry !== undefined) {
            if (entry.value === DELETED) return undefined;
            if (col in entry.value) return { key, value: entry.value[col] as T[Column], time: entry.time };
            // column not set in the overlay entry — fall through to disk for this column
        }
        let time = Date.now();
        let reader = await this.reader();
        const r = await reader.getSingleField(key, col);
        time = Date.now() - time;
        if (time > 50) {
            console.log(`${blue(`${this.name}.getSingleFieldObj(${JSON.stringify(key)}, ${JSON.stringify(column)})`)} took ${red(formatTime(time))} ${this.formatInfo(reader)}`);
        }
        if (r === undefined) {
            // Not live on disk; but if the overlay holds the key (a partial write of a not-yet-on-disk
            // key) it's live with this column unset.
            if (entry !== undefined && entry.value !== DELETED) return { key, value: undefined as T[Column], time: entry.time };
            return undefined;
        }
        return { key, value: r.value as T[Column], time: r.time };
    }

    public async getColumn<Column extends keyof T>(column: Column): Promise<{ key: string; value: T[Column]; time: number }[]> {
        void this.syncSetup();
        let time = Date.now();
        let reader = await this.reader();
        let base = await reader.getColumn(String(column));
        let result = this.patchColumn(base, String(column)) as { key: string; value: T[Column]; time: number }[];
        time = Date.now() - time;
        if (time > 50) {
            console.log(`${blue(`${this.name}.getColumn(${JSON.stringify(column)})`)} took ${red(formatTime(time))} ${this.formatInfo(reader)}`);
        }
        return result;
    }

    public async getKeys(): Promise<string[]> {
        void this.syncSetup();
        let reader = await this.reader();
        if (this.overlay.size === 0) return reader.keys;
        let set = new Set(reader.keys);
        for (const [key, entry] of this.overlay) {
            if (entry.value === DELETED) set.delete(key);
            else set.add(key);
        }
        return [...set];
    }

    // ---- sync (reactive) reads ----
    // These observe the overlay + load signals, so a reactive context that reads them re-runs when a
    // write/delete happens or when a base value finishes loading. The immutable base column/field is
    // loaded once and cached; the overlay is layered on top (we can't async-cache the combined result
    // because the overlay mutates).

    private baseColumns = new Map<string, { key: string; value: unknown; time: number }[]>();
    private baseColumnsLoading = new Set<string>();
    // The disk-resolved field: { value, time } when the key is live on disk, or undefined when it isn't
    // (Map.has distinguishes "loaded" from "not loaded yet").
    private baseFields = new Map<string, { value: unknown; time: number } | undefined>();
    private baseFieldsLoading = new Set<string>();

    private ensureBaseColumn(column: string) {
        if (this.baseColumns.has(column) || this.baseColumnsLoading.has(column)) return;
        this.baseColumnsLoading.add(column);
        void (async () => {
            let reader = await this.reader();
            let base = await reader.getColumn(column);
            this.deps.batch(() => {
                this.baseColumns.set(column, base);
                this.baseColumnsLoading.delete(column);
                this.deps.invalidate(LOAD_SIGNAL);
            });
        })();
    }

    private ensureBaseField(key: string, column: string) {
        let cacheKey = nullJoin(column, key);
        if (this.baseFields.has(cacheKey) || this.baseFieldsLoading.has(cacheKey)) return;
        this.baseFieldsLoading.add(cacheKey);
        void (async () => {
            let reader = await this.reader();
            let resolved = await reader.getSingleField(key, column);
            this.deps.batch(() => {
                this.baseFields.set(cacheKey, resolved);
                this.baseFieldsLoading.delete(cacheKey);
                this.deps.invalidate(LOAD_SIGNAL);
            });
        })();
    }

    public getSingleFieldSync<Column extends keyof T>(key: string, column: Column): T[Column] | undefined {
        return this.getSingleFieldObjSync(key, column)?.value;
    }

    // Sync (reactive) counterpart of getSingleFieldObj: { key, value, time } once loaded, undefined while
    // loading or when the key isn't present/live. time is roughly when the value last changed.
    public getSingleFieldObjSync<Column extends keyof T>(key: string, column: Column): { key: string; value: T[Column]; time: number } | undefined {
        void this.syncSetup();
        this.deps.observe(LOAD_SIGNAL);
        this.deps.observe(key);
        let col = String(column);
        let entry = this.overlay.get(key);
        if (entry !== undefined) {
            if (entry.value === DELETED) return undefined;
            if (col in entry.value) return { key, value: entry.value[col] as T[Column], time: entry.time };
            // column not set in the overlay entry — fall through to the base field cache for this column
        }
        let cacheKey = nullJoin(col, key);
        if (!this.baseFields.has(cacheKey)) {
            this.ensureBaseField(key, col);
            return undefined;
        }
        const base = this.baseFields.get(cacheKey);
        if (base === undefined) {
            // Not live on disk; but an overlay entry for the key (partial write) makes it live, column unset.
            if (entry !== undefined && entry.value !== DELETED) return { key, value: undefined as T[Column], time: entry.time };
            return undefined;
        }
        return { key, value: base.value as T[Column], time: base.time };
    }

    public getColumnSync<Column extends keyof T>(column: Column): { key: string; value: T[Column]; time: number }[] | undefined {
        void this.syncSetup();
        this.deps.observe(LOAD_SIGNAL);
        // Observe the overlay-wide signal so we recompute once the base arrives or the overlay changes.
        this.deps.observe(OVERLAY_SIGNAL);
        let col = String(column);
        let base = this.baseColumns.get(col);
        if (!base) {
            this.ensureBaseColumn(col);
            return undefined;
        }
        return this.patchColumn(base, col) as { key: string; value: T[Column]; time: number }[];
    }

    public async getColumnInfo() {
        let reader = await this.reader();
        return reader.columns;
    }

    public async getReaderInfo() {
        let reader = await this.reader();
        return {
            rowCount: reader.rowCount,
            totalBytes: reader.totalBytes,
            keyCount: reader.keys.length,
            sampleKey: reader.keys[0] as string | undefined,
            columns: reader.columns,
        };
    }
}

// The merged, time-resolved view over all readers. getColumn/getSingleField return the resolved value
// AND its write-time (so reads can expose roughly when a value last changed); the base layers the
// overlay on top of these. getSingleField returns undefined only when the key isn't live (deleted or
// absent) — a live key whose column is merely unset returns { value: undefined, time: rowTime }.
type ResolvedReader = {
    rowCount: number;
    totalBytes: number;
    keys: string[];
    columns: { column: string; byteSize: number }[];
    getColumn: (column: string) => Promise<{ key: string; value: unknown; time: number }[]>;
    getSingleField: (key: string, column: string) => Promise<{ value: unknown; time: number } | undefined>;
};

// Resolve every read by ACTUAL write-time across all readers (stream + bulk), per key and per column:
//  - a column resolves to the value with the newest write-time among readers that set it (non-ABSENT);
//    a reader that never set the column for that key falls through to an older reader.
//  - a key is live iff its newest write is newer than its newest delete; per column, the value is
//    suppressed if a delete is newer than that column's newest set.
// No reliance on file order or partitioning — time is the only thing that decides.
async function joinBulkDatabases(databases: BaseBulkDatabaseReader[]): Promise<ResolvedReader> {
    const deleteTime = new Map<string, number>();
    for (const db of databases) {
        if (!db.deleteTimes) continue;
        for (const [key, t] of db.deleteTimes) deleteTime.set(key, Math.max(deleteTime.get(key) ?? -Infinity, t));
    }
    const keyTime = new Map<string, number>();
    for (const db of databases) {
        for (const [key, t] of db.keyTimes) keyTime.set(key, Math.max(keyTime.get(key) ?? -Infinity, t));
    }
    const delOf = (key: string) => deleteTime.get(key) ?? -Infinity;
    // Live keys: newest write strictly newer than newest delete.
    const keys: string[] = [];
    for (const [key, t] of keyTime) if (t > delOf(key)) keys.push(key);

    const columns: { column: string; byteSize: number }[] = [];
    const columnByName = new Map<string, { column: string; byteSize: number }>();
    for (const db of databases) {
        for (const col of db.columns) {
            let existing = columnByName.get(col.column);
            if (!existing) {
                existing = { column: col.column, byteSize: 0 };
                columnByName.set(col.column, existing);
                columns.push(existing);
            }
            existing.byteSize += col.byteSize;
        }
    }

    return {
        totalBytes: databases.reduce((acc, db) => acc + db.totalBytes, 0),
        rowCount: keys.length,
        keys,
        columns,
        async getColumn(column) {
            const perReader = await Promise.all(databases.map(async db => {
                if (!db.columns.some(c => c.column === column)) return undefined;
                const entries = await db.getColumn(column);
                return new Map(entries.map(e => [e.key, { value: e.value, time: e.time }]));
            }));
            return keys.map(key => {
                let bestTime = -Infinity;
                let bestVal: unknown;
                let found = false;
                for (const m of perReader) {
                    const cell = m && m.get(key);
                    if (!cell || cell.value === ABSENT) continue;
                    if (cell.time > bestTime) { bestTime = cell.time; bestVal = cell.value; found = true; }
                }
                // time = the column value's write-time when this column has one, else the row's last
                // write-time (the key is live but never set this column).
                const live = found && bestTime > delOf(key);
                return { key, value: live ? bestVal : undefined, time: live ? bestTime : (keyTime.get(key) ?? 0) };
            });
        },
        async getSingleField(key, column) {
            const kt = keyTime.get(key);
            if (kt === undefined || kt <= delOf(key)) return undefined; // key not live
            let bestTime = -Infinity;
            let bestVal: unknown;
            let found = false;
            for (const db of databases) {
                if (!db.columns.some(c => c.column === column)) continue;
                const r = await db.getSingleField(key, column);
                if (r === ABSENT) continue;
                if (r.time > bestTime) { bestTime = r.time; bestVal = r.value; found = true; }
            }
            const live = found && bestTime > delOf(key);
            return { value: live ? bestVal : undefined, time: live ? bestTime : kt };
        },
    };
}
