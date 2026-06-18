import { sort } from "socket-function/src/misc";
import { getTimeUnique } from "socket-function/src/bits";
import { ABSENT, BaseBulkDatabaseReader, buildFileBuffer, EMPTY_BUFFER, KEY_COLUMN, loadBulkDatabase } from "./BulkDatabaseFormat";
import { lazy } from "socket-function/src/caching";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { blue, red } from "socket-function/src/formatting/logColors";
import { blockCache, encodeCompressedBlocks, GetRange } from "./blockCache";
import { STREAM_EXTENSION, StreamEntry, frameRows, frameDeletes, parseStream, streamReaderFromEntries } from "./streamLog";
import { connect as syncConnect, broadcast as syncBroadcast, isSyncSupported, RemoteWrite } from "./syncClient";
import type { FileStorage } from "../FileFolderAPI";

// BulkDatabase2's compressed-block format is not compatible with BulkDatabase, so it uses its own
// folder rather than sharing bulkDatabases/.
const BULK_ROOT_FOLDER = "bulkDatabases2";
const FILE_EXTENSION = ".bulk";
// Once this many bulk files pile up we run a merge pass to consolidate small ones (bounded by the
// byte caps below), so reads don't fan out across an unbounded number of files.
const MERGE_FILE_COUNT = 8;

// Memory ceiling for a single merge. Files are merged in contiguous (newest-first) runs whose combined
// LOGICAL (uncompressed) size stays under MERGE_MAX_BYTES, so a merge never reads more than this into
// memory at once. A file at or above MERGE_MIN_BYTES is "sealed": big enough already, never read back
// in to be merged again. Sizes are measured uncompressed (from each file's index) because that — not
// the smaller on-disk compressed size — is what actually lands in memory during a merge.
const MERGE_MIN_BYTES = 400 * 1024 * 1024;
const MERGE_MAX_BYTES = 800 * 1024 * 1024;

// Tier-0 streaming rolls over into a columnar bulk file once it gets big enough — by row count,
// byte size, or file count (many threads each stream to their own file). A single writeBatch that
// already exceeds the row/byte limits skips streaming and writes a bulk file directly.
const ROLLOVER_ROWS = 5000;
const ROLLOVER_BYTES = 5 * 1024 * 1024;
const ROLLOVER_FILES = 100;

// An unreadable file might be a write that is still in progress (another thread), so we can't delete
// it on sight. Once it has been unreadable for longer than this (by its filename timestamp), no
// writer is plausibly still working on it, so we delete it. Until then we just warn.
const STALE_DELETE_MS = 24 * 60 * 60 * 1000;

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
// field kept so the name stays in the historical level_timestamp_counter shape parseFileName expects.
function newFileName(timestamp: number): string {
    fileNameCounter++;
    return `0_${timestamp}_${fileNameCounter}${FILE_EXTENSION}`;
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
    if (parts.length !== 3) return undefined;
    const level = parseInt(parts[0], 10);
    const timestamp = parseInt(parts[1], 10);
    if (!Number.isFinite(level) || !Number.isFinite(timestamp)) return undefined;
    return { fileName, level, timestamp };
}

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
    private streamRowsWritten = 0;
    private getStreamFileName(): string {
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

    private reader = lazy(async (): Promise<BaseBulkDatabaseReader> => {
        let start = Date.now();
        const [bulkFiles, streamFiles] = await Promise.all([this.listFiles(), this.listStreamFiles()]);
        // Load everything in parallel: each bulk file's columnar reader, plus all streamed entries.
        // A corrupt/truncated bulk file is skipped with a warning rather than breaking the load or
        // returning bad values: the write protocol always writes a new file before removing the old
        // ones it supersedes, so a partially-written file's data still exists in another file.
        const [bulkReadersRaw, streamData] = await Promise.all([
            Promise.all(bulkFiles.map(async f => {
                try {
                    return await this.loadFileReader(f.fileName);
                } catch (e) {
                    await this.handleUnreadableFile(f, (e as Error).message);
                    return undefined;
                }
            })),
            this.loadStreamEntries(streamFiles),
        ]);
        const bulkReaders = bulkReadersRaw.filter((r): r is BaseBulkDatabaseReader => !!r);
        // Streamed entries are the newest writes, so their reader goes first (the join is newest-wins
        // and lets the stream's deletes tombstone keys in the older bulk readers).
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
        const joined = joinBulkDatabases(readers);

        let time = Date.now() - start;
        if (time > 50) {
            console.log(`${blue(`${this.name} loaded`)} in ${red(formatTime(time))} (${blue(formatNumber(joined.rowCount))} rows, ${bulkFiles.length} bulk + ${streamFiles.length} stream files)`);
        }
        return joined;
    });

    // Connects to the cross-tab BroadcastChannel (browser only) so writes in other tabs of this
    // collection update our overlay. Runs once; no-op in Node / where BroadcastChannel is unavailable.
    // We wait for the reader (and thus streamTimes) first so conflict resolution can see disk
    // timestamps, then peers reply to our hello with recent writes that may not be on disk yet (applied
    // through the same applyRemote callback).
    private syncSetup = lazy(async () => {
        if (!isSyncSupported()) return;
        await this.reader();
        let recent = await syncConnect(this.name, write => this.applyRemote(write));
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

        // A batch that already exceeds the rollover limits skips tier-0 and writes a bulk file directly.
        if (entries.length >= ROLLOVER_ROWS || framed.length >= ROLLOVER_BYTES) {
            await this.writeBulkFile(rows);
            this.resetReader();
            return;
        }

        // Otherwise append to this thread's stream file (one cheap append) and reflect it in the
        // overlay immediately — no reader reset.
        const storage = await this.storage();
        await storage.append(this.getStreamFileName(), framed);
        this.streamRowsWritten += entries.length;
        this.deps.batch(() => {
            for (const { time, row } of stamped) this.setOverlayRow(row.key as string, row, time);
        });
        for (const { time, row } of stamped) syncBroadcast(this.name, { key: row.key as string, time, value: row });
        await this.maybeRolloverStream();
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
        this.streamRowsWritten += keys.length;
        this.deps.batch(() => {
            for (const { time, key } of stamped) this.setOverlayDeleted(key, time);
        });
        for (const { time, key } of stamped) syncBroadcast(this.name, { key, time, deleted: true });
        await this.maybeRolloverStream();
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

    // Writes the rows as one or more columnar bulk files (buildFileBuffer splits a too-large batch by
    // row range so no single file approaches the Buffer size limit), all sharing one timestamp since
    // they're one write with disjoint keys. Then, if enough files have accumulated, runs bounded merge
    // passes until nothing more can be consolidated.
    private async writeBulkFile(rows: Record<string, unknown>[]): Promise<void> {
        const storage = await this.storage();
        const timestamp = nextFileTime();
        for (const buffer of buildFileBuffer(rows)) {
            await storage.set(newFileName(timestamp), encodeCompressedBlocks(buffer));
        }
        if ((await this.listFiles()).length >= MERGE_FILE_COUNT) {
            while (await this.mergeFiles() > 0) { /* keep merging until no run can be consolidated */ }
        }
    }

    private async listStreamFiles(): Promise<StreamFileInfo[]> {
        const storage = await this.storage();
        const names = await storage.getKeys();
        const files = names.flatMap(n => {
            const parsed = parseStreamFileName(n);
            return parsed && [parsed] || [];
        });
        sort(files, f => f.timestamp);
        return files;
    }

    // Reads and parses every stream file in parallel. Returns per-write entries (each carrying its
    // unique timestamp + originating file) so callers can order writes globally across files.
    private async loadStreamEntries(streamFiles: StreamFileInfo[]): Promise<{ entries: { time: number; fileName: string; entry: StreamEntry }[]; totalBytes: number }> {
        if (!streamFiles.length) return { entries: [], totalBytes: 0 };
        const storage = await this.storage();
        const buffers = await Promise.all(streamFiles.map(f => storage.get(f.fileName)));
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
        return { entries, totalBytes };
    }

    // Global mutation order across per-thread files: by unique timestamp, ties broken by file name.
    private orderStreamEntries(entries: { time: number; fileName: string; entry: StreamEntry }[]): StreamEntry[] {
        entries.sort((a, b) => {
            if (a.time !== b.time) return a.time - b.time;
            return a.fileName < b.fileName && -1 || a.fileName > b.fileName && 1 || 0;
        });
        return entries.map(e => e.entry);
    }

    private async maybeRolloverStream(): Promise<void> {
        const streamFiles = await this.listStreamFiles();
        const storage = await this.storage();
        let totalBytes = 0;
        for (const f of streamFiles) {
            const info = await storage.getInfo(f.fileName);
            totalBytes += info?.size || 0;
        }
        if (streamFiles.length > ROLLOVER_FILES || totalBytes > ROLLOVER_BYTES || this.streamRowsWritten > ROLLOVER_ROWS) {
            await this.rolloverStream(streamFiles);
        }
    }

    // Combine all tier-0 stream files into a single columnar bulk file (newest-wins per key, deletes
    // applied), delete the consumed stream files, and re-persist surviving tombstones to a fresh
    // stream file so deletes of keys that live in older bulk files are not lost.
    private async rolloverStream(streamFiles: StreamFileInfo[]): Promise<void> {
        const { entries } = await this.loadStreamEntries(streamFiles);
        const ordered = this.orderStreamEntries(entries);
        const byKey = new Map<string, Record<string, unknown>>();
        const deleted = new Map<string, number>();
        for (const e of ordered) {
            if (e.deletedKey !== undefined) {
                byKey.delete(e.deletedKey);
                deleted.set(e.deletedKey, e.time);
            } else if (e.row) {
                let key = e.row.key as string;
                // Merge partial writes/updates so unset columns aren't lost; columns never set in this
                // stream stay absent in the rolled row and fall through to older bulk files on read.
                byKey.set(key, { ...byKey.get(key), ...e.row });
                deleted.delete(key);
            }
        }
        if (byKey.size) await this.writeBulkFile([...byKey.values()]);
        const storage = await this.storage();
        // Persist surviving tombstones (keeping their original timestamps) to a FRESH stream file
        // before removing the consumed files, so a crash in between can't drop the deletes. The window
        // is at worst redundant (deletes present in both old and new files), never missing.
        this.streamFileName = undefined;
        this.streamRowsWritten = 0;
        if (deleted.size) {
            await storage.append(this.getStreamFileName(), frameDeletes([...deleted].map(([key, time]) => ({ time, key }))));
        }
        for (const f of streamFiles) await storage.remove(f.fileName);
        this.resetReader();
    }

    // Consolidate as much as the caps allow: repeatedly merge contiguous non-sealed runs until nothing
    // more can be combined. Unlike a naive "merge everything into one file", this respects MERGE_MAX_BYTES
    // so it never loads the whole collection into memory — a multi-GB collection settles into several
    // capped files (sealed files are left as-is) rather than one giant one.
    public async compact(): Promise<void> {
        let merged = false;
        while (await this.mergeFiles() > 0) merged = true;
        if (merged) this.resetReader();
    }

    private async listFiles(): Promise<BulkFileInfo[]> {
        const storage = await this.storage();
        const names = await storage.getKeys();
        const files = names.flatMap(n => {
            const parsed = parseFileName(n);
            return parsed && [parsed] || [];
        });
        // Newest-first by timestamp; ties broken by file name (descending) for a deterministic order.
        // A merged file inherits the newest timestamp of the run it replaced, so it lands exactly where
        // that run was — keeping newest-wins correct without any level bookkeeping.
        files.sort((a, b) => {
            if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
            return a.fileName < b.fileName && 1 || a.fileName > b.fileName && -1 || 0;
        });
        return files;
    }

    private async makeRawGetRange(fileName: string): Promise<{ rawGetRange: GetRange; size: number } | undefined> {
        const storage = await this.storage();
        const info = await storage.getInfo(fileName);
        if (!info) return undefined;
        const rawGetRange: GetRange = async (start, end) => {
            if (end <= start) return EMPTY_BUFFER;
            const buf = await storage.getRange(fileName, { start, end });
            if (!buf) {
                throw new Error(`Expected range [${start}, ${end}) of ${fileName}, file was missing`);
            }
            return buf;
        };
        return { rawGetRange, size: info.size };
    }

    private async loadFileReader(fileName: string): Promise<BaseBulkDatabaseReader> {
        const raw = await this.makeRawGetRange(fileName);
        if (!raw) {
            throw new Error(`Expected bulk file to exist, was missing: ${fileName}`);
        }
        const fileId = nullJoin(this.name, fileName);
        // Files are immutable and stored as compressed blocks; replace getRange with a block-cached,
        // decompressing version (same interface) and read the logical (uncompressed) size from its
        // index. open() validates the file size against the index and throws if it's truncated/corrupt.
        const opened = await blockCache.open(fileId, raw.size, raw.rawGetRange);
        return loadBulkDatabase({ totalBytes: opened.uncompressedSize, getRange: opened.getRange });
    }

    // Logical (uncompressed) size of a bulk file, read from its (cached) index without loading data.
    // Used by the merge planner to bound how much it reads at once. Returns undefined for a file that's
    // missing or unreadable so the planner simply leaves it out of any merge.
    private async fileLogicalSize(fileName: string): Promise<number | undefined> {
        try {
            const raw = await this.makeRawGetRange(fileName);
            if (!raw) return undefined;
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

    // Merges exactly the files it's given (already newest-first), writing the result with `timestamp`
    // so the new file takes the slot of the run it replaced, then deletes the consumed files. The merge
    // is per-COLUMN newest-wins: for each key, each column takes the value from the newest reader that
    // set it (non-ABSENT), so a partial write in a newer file doesn't drop columns that live only in an
    // older file. Columns absent from every merged reader stay absent (they keep falling through to
    // files outside this run). The caller keeps the input under MERGE_MAX_BYTES — this reads it all in.
    private async mergeFilesBase(files: BulkFileInfo[], timestamp: number): Promise<void> {
        const storage = await this.storage();
        const readers = await Promise.all(files.map(f => this.loadFileReader(f.fileName)));

        // Load each reader's columns into key->value maps (values may be ABSENT for unset cells).
        const loaded = await Promise.all(readers.map(async reader => {
            const cols: { column: string; values: Map<string, unknown> }[] = [];
            for (const col of reader.columns) {
                if (col.column === KEY_COLUMN) continue;
                const entries = await reader.getColumn(col.column);
                cols.push({ column: col.column, values: new Map(entries.map(e => [e.key, e.value])) });
            }
            return { keys: reader.keys, keySet: new Set(reader.keys), cols };
        }));

        const seen = new Set<string>();
        const mergedRows: Record<string, unknown>[] = [];
        for (const reader of loaded) {
            for (const key of reader.keys) {
                if (seen.has(key)) continue;
                seen.add(key);
                const row: Record<string, unknown> = { [KEY_COLUMN]: key };
                const filled = new Set<string>();
                for (const r of loaded) {
                    if (!r.keySet.has(key)) continue;
                    for (const c of r.cols) {
                        if (filled.has(c.column)) continue;
                        const value = c.values.get(key);
                        if (value === ABSENT) continue;
                        row[c.column] = value;
                        filled.add(c.column);
                    }
                }
                mergedRows.push(row);
            }
        }

        // The input is under the cap, so buildFileBuffer almost always returns a single buffer; the loop
        // is only here to stay correct if a merge's deduped output still happens to exceed the split size.
        for (const buffer of buildFileBuffer(mergedRows)) {
            await storage.set(newFileName(timestamp), encodeCompressedBlocks(buffer));
        }
        for (const f of files) {
            await storage.remove(f.fileName);
        }
    }

    // The cap-aware merge planner. Walks the files newest-first and merges contiguous runs of
    // non-sealed files, each run capped at MERGE_MAX_BYTES of LOGICAL size so a single merge never
    // loads more than that into memory. A file at/over MERGE_MIN_BYTES is sealed (left untouched) and
    // breaks the run, as does an unreadable file. Because each run is contiguous in the newest-first
    // order and its merged file keeps the run's newest timestamp, newest-wins ordering is preserved
    // with no inversions. Returns the number of runs merged (0 means nothing left to consolidate).
    private async mergeFiles(): Promise<number> {
        const files = await this.listFiles();
        const sizes = await Promise.all(files.map(f => this.fileLogicalSize(f.fileName)));

        const batches: BulkFileInfo[][] = [];
        let batch: BulkFileInfo[] = [];
        let batchBytes = 0;
        const flush = () => {
            // A run of one file is pointless to "merge" — only consolidate when there are at least two.
            if (batch.length >= 2) batches.push(batch);
            batch = [];
            batchBytes = 0;
        };
        for (let i = 0; i < files.length; i++) {
            const size = sizes[i];
            if (size === undefined || size >= MERGE_MIN_BYTES) {
                flush();
                continue;
            }
            if (batch.length && batchBytes + size > MERGE_MAX_BYTES) flush();
            batch.push(files[i]);
            batchBytes += size;
        }
        flush();

        // batch[0] is the newest file in each (newest-first) run, so its timestamp is the run's slot.
        for (const runFiles of batches) {
            await this.mergeFilesBase(runFiles, runFiles[0].timestamp);
        }
        return batches.length;
    }

    private formatInfo(reader: BaseBulkDatabaseReader): string {
        return `(collection has ${blue(formatNumber(reader.rowCount))} rows, ${blue(formatNumber(reader.totalBytes))}B)`;
    }

    // Applies the overlay (pending writes/deletes) on top of a base column. No-op when empty. An
    // overlay entry that doesn't include this column leaves the base (disk) value in place — a partial
    // write/update only overrides the columns it set; everything else falls through.
    private patchColumn(base: { key: string; value: unknown }[], column: string): { key: string; value: unknown }[] {
        if (this.overlay.size === 0) return base;
        const map = new Map(base.map(e => [e.key, e.value]));
        for (const [key, entry] of this.overlay) {
            if (entry.value === DELETED) { map.delete(key); continue; }
            if (column in entry.value) map.set(key, entry.value[column]);
            else if (!map.has(key)) map.set(key, undefined);
        }
        return [...map].map(([key, value]) => ({ key, value }));
    }

    // ---- async reads (overlay-aware) ----

    public async getSingleField<Column extends keyof T>(key: string, column: Column): Promise<T[Column] | undefined> {
        void this.syncSetup();
        const entry = this.overlay.get(key);
        if (entry !== undefined) {
            if (entry.value === DELETED) return undefined;
            if (String(column) in entry.value) return entry.value[String(column)] as T[Column];
            // column not set in the overlay entry — fall through to disk
        }
        let time = Date.now();
        let reader = await this.reader();
        let result = await reader.getSingleField(key, String(column)) as T[Column] | undefined;
        time = Date.now() - time;
        if (time > 50) {
            console.log(`${blue(`${this.name}.getSingleField(${JSON.stringify(key)}, ${JSON.stringify(column)})`)} took ${red(formatTime(time))} ${this.formatInfo(reader)}`);
        }
        return result;
    }

    public async getColumn<Column extends keyof T>(column: Column): Promise<{ key: string; value: T[Column] }[]> {
        void this.syncSetup();
        let time = Date.now();
        let reader = await this.reader();
        let base = await reader.getColumn(String(column)) as { key: string; value: T[Column] }[];
        let result = this.patchColumn(base, String(column)) as { key: string; value: T[Column] }[];
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

    private baseColumns = new Map<string, { key: string; value: unknown }[]>();
    private baseColumnsLoading = new Set<string>();
    private baseFields = new Map<string, unknown>();
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
            let value = await reader.getSingleField(key, column);
            this.deps.batch(() => {
                this.baseFields.set(cacheKey, value);
                this.baseFieldsLoading.delete(cacheKey);
                this.deps.invalidate(LOAD_SIGNAL);
            });
        })();
    }

    public getSingleFieldSync<Column extends keyof T>(key: string, column: Column): T[Column] | undefined {
        void this.syncSetup();
        this.deps.observe(LOAD_SIGNAL);
        this.deps.observe(key);
        let col = String(column);
        let entry = this.overlay.get(key);
        if (entry !== undefined) {
            if (entry.value === DELETED) return undefined;
            if (col in entry.value) return entry.value[col] as T[Column];
            // column not set in the overlay entry — fall through to the base field cache
        }
        let cacheKey = nullJoin(col, key);
        if (!this.baseFields.has(cacheKey)) {
            this.ensureBaseField(key, col);
            return undefined;
        }
        return this.baseFields.get(cacheKey) as T[Column] | undefined;
    }

    public getColumnSync<Column extends keyof T>(column: Column): { key: string; value: T[Column] }[] | undefined {
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
        return this.patchColumn(base, col) as { key: string; value: T[Column] }[];
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

// Lowest indexes are read first (newest-wins). A reader's deletedKeys tombstone a key in all older
// readers; the newest reader that has a key live wins.
function joinBulkDatabases(databases: BaseBulkDatabaseReader[]): BaseBulkDatabaseReader {
    const keySets = databases.map(db => new Set(db.keys));
    const deleted = new Set<string>();
    for (const db of databases) {
        if (db.deletedKeys) for (const key of db.deletedKeys) deleted.add(key);
    }

    const keys: string[] = [];
    const keySeen = new Set<string>();
    for (const db of databases) {
        for (const key of db.keys) {
            if (keySeen.has(key) || deleted.has(key)) continue;
            keySeen.add(key);
            keys.push(key);
        }
    }
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
            // Resolve each key newest-wins, per column: the newest reader that has a non-ABSENT value
            // for the key wins; an ABSENT cell (the row never set this column) falls through to an older
            // reader. A stored undefined is a real value and stops the fall-through (clears the column).
            const valueByKey = new Map<string, unknown>();
            for (const db of databases) {
                let values: Map<string, unknown> | undefined;
                if (db.columns.some(c => c.column === column)) {
                    values = new Map((await db.getColumn(column)).map(e => [e.key, e.value]));
                }
                for (const key of db.keys) {
                    if (valueByKey.has(key) || deleted.has(key)) continue;
                    const value = values ? values.get(key) : ABSENT;
                    if (value === ABSENT) continue;
                    valueByKey.set(key, value);
                }
            }
            return keys.map(key => ({ key, value: valueByKey.get(key) }));
        },
        async getSingleField(key, column) {
            if (deleted.has(key)) return undefined;
            for (let i = 0; i < databases.length; i++) {
                if (!keySets[i].has(key)) continue;
                // Column not in this reader at all, or the row didn't set it (ABSENT): fall through to
                // an older reader rather than clobbering with undefined.
                if (!databases[i].columns.some(c => c.column === column)) continue;
                const value = await databases[i].getSingleField(key, column);
                if (value === ABSENT) continue;
                return value;
            }
            return undefined;
        },
    };
}
