import { getFileStorageNested, getFileStorageNested2 } from "../FileFolderAPI";
import { sort } from "socket-function/src/misc";
import { getTimeUnique } from "socket-function/src/bits";
import { BaseBulkDatabaseReader, buildFileBuffer, EMPTY_BUFFER, loadBulkDatabase } from "./BulkDatabaseFormat";
import { lazy } from "socket-function/src/caching";
import { observable, runInAction } from "../../render-utils/mobxTyped";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { blue, green, red } from "socket-function/src/formatting/logColors";
import { blockCache, encodeCompressedBlocks, GetRange } from "./blockCache";
import { STREAM_EXTENSION, StreamEntry, frameRows, frameDeletes, parseStream, streamReaderFromEntries } from "./streamLog";
import { connect as syncConnect, broadcast as syncBroadcast, isSyncSupported, RemoteWrite } from "./syncClient";

// BulkDatabase2's compressed-block format is not compatible with BulkDatabase, so it uses its own
// folder rather than sharing bulkDatabases/.
const BULK_ROOT_FOLDER = "bulkDatabases2";
const FILE_EXTENSION = ".bulk";
// When a level accumulates this many files they are merged into one file at the next level up, cascading, so write count stays O(log n) files.
const MERGE_FILE_COUNT = 8;

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

let fileNameCounter = 0;

type BulkFileInfo = { fileName: string; level: number; timestamp: number };

function newFileName(level: number): string {
    fileNameCounter++;
    return `${level}_${Date.now()}_${fileNameCounter}${FILE_EXTENSION}`;
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

export class BulkDatabase2<T extends { key: string }> {
    constructor(public readonly name: string) { }

    // Block range cache is global and immutable-file-safe; clear it to simulate a cold page load
    // (e.g. between an untimed prep step and the timed benchmark).
    public static clearCache() {
        blockCache.clear();
    }

    private storage = lazy(async () => getFileStorageNested2(`${BULK_ROOT_FOLDER}/${this.name}`));

    // In-memory overlay of pending writes/deletes, observable so reads re-render when it changes. It
    // takes priority over the loaded readers, so writes are reflected in reads without reloading.
    //
    // NOTE: we never bound or clear this in-memory state during normal operation (only on a structural
    // rollover/reset, where the data has been persisted into bulk files). The whole database must be
    // resident in memory anyway — file merging reads every row — so a database large enough to blow
    // the in-memory cache would already fail at merge time. There is no partial-load mode.
    private overlay = observable.map<string, OverlayEntry>();
    // Latest stream-on-disk timestamp per key (from the loaded stream files). Used together with the
    // overlay to decide whether an incoming remote write is actually newer than what we have.
    private streamTimes = new Map<string, number>();
    // Bumped whenever a base column/field finishes loading or the reader resets, so sync reads that
    // returned "still loading" re-render once data is available.
    private loadVersion = observable.box(0);

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

    // Connects to the SharedWorker (browser only) so writes in other tabs of this collection update
    // our observable overlay. Runs once; no-op in Node / where SharedWorker is unavailable. We wait
    // for the reader (and thus streamTimes) first so conflict resolution can see disk timestamps, then
    // apply the worker's buffered recent writes (which may not be on disk yet).
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
        runInAction(() => {
            if (write.deleted) this.overlay.set(write.key, { time: write.time, value: DELETED });
            else this.overlay.set(write.key, { time: write.time, value: write.value as Record<string, unknown> });
        });
    }

    // Reset the loaded reader and all derived in-memory caches/overlay. Used only on structural
    // changes (large direct-bulk write, rollover, compact) after the data has been persisted.
    private resetReader() {
        runInAction(() => {
            this.reader.reset();
            this.baseColumns.clear();
            this.baseColumnsLoading.clear();
            this.baseFields.clear();
            this.baseFieldsLoading.clear();
            this.overlay.clear();
            this.loadVersion.set(this.loadVersion.get() + 1);
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
        // observable overlay immediately — no reader reset.
        const storage = await this.storage();
        await storage.append(this.getStreamFileName(), framed);
        this.streamRowsWritten += entries.length;
        runInAction(() => {
            for (const { time, row } of stamped) this.overlay.set(row.key as string, { time, value: row });
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
        runInAction(() => {
            for (const { time, key } of stamped) this.overlay.set(key, { time, value: DELETED });
        });
        for (const { time, key } of stamped) syncBroadcast(this.name, { key, time, deleted: true });
        await this.maybeRolloverStream();
    }

    // Writes one columnar bulk file at level 0, then cascades level merges.
    private async writeBulkFile(rows: Record<string, unknown>[]): Promise<void> {
        const storage = await this.storage();
        await storage.set(newFileName(0), encodeCompressedBlocks(buildFileBuffer(rows)));
        // Cascade merge: any level at >= MERGE_FILE_COUNT files merges into one file at level+1, repeating up the tree.
        while (true) {
            const files = await this.listFiles();
            const byLevel = new Map<number, BulkFileInfo[]>();
            for (const f of files) {
                let list = byLevel.get(f.level);
                if (!list) {
                    list = [];
                    byLevel.set(f.level, list);
                }
                list.push(f);
            }
            const levels = [...byLevel.keys()];
            sort(levels, l => l);
            const mergeLevel = levels.find(l => {
                const list = byLevel.get(l);
                return list && list.length >= MERGE_FILE_COUNT;
            });
            if (mergeLevel === undefined) break;
            const levelFiles = byLevel.get(mergeLevel);
            if (!levelFiles) {
                throw new Error(`Expected files at level ${mergeLevel}, was empty`);
            }
            await this.mergeFiles(levelFiles, mergeLevel + 1);
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
                byKey.set(key, e.row);
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

    // Force-merge every on-disk file into a single new file regardless of how many there are.
    public async compact(): Promise<void> {
        const files = await this.listFiles();
        if (files.length < 2) return;
        const maxLevel = files.reduce((m, f) => Math.max(m, f.level), 0);
        await this.mergeFiles(files, maxLevel + 1);
        this.resetReader();
    }

    private async listFiles(): Promise<BulkFileInfo[]> {
        const storage = await this.storage();
        const names = await storage.getKeys();
        const files = names.flatMap(n => {
            const parsed = parseFileName(n);
            return parsed && [parsed] || [];
        });
        // Sort is stable, so timestamps stay newest-first within each level. Lower levels are always newer than higher levels (a merge consumes every file at its level, so survivors postdate it).
        sort(files, f => -f.timestamp);
        sort(files, f => f.level);
        return files;
    }

    private async loadFileReader(fileName: string): Promise<BaseBulkDatabaseReader> {
        const storage = await this.storage();
        const info = await storage.getInfo(fileName);
        if (!info) {
            throw new Error(`Expected bulk file to exist, was missing: ${fileName}`);
        }
        const fileId = `${this.name}\u0000${fileName}`;
        let getRange: GetRange = async (start, end) => {
            if (end <= start) return EMPTY_BUFFER;
            const buf = await storage.getRange(fileName, { start, end });
            if (!buf) {
                throw new Error(`Expected range [${start}, ${end}) of ${fileName}, file was missing`);
            }
            return buf;
        };
        // Files are immutable and stored as compressed blocks; replace getRange with a block-cached,
        // decompressing version (same interface) and read the logical (uncompressed) size from its
        // index. open() validates the file size against the index and throws if it's truncated/corrupt.
        const opened = await blockCache.open(fileId, info.size, getRange);
        return loadBulkDatabase({ totalBytes: opened.uncompressedSize, getRange: opened.getRange });
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

    // Read every row from `files` (already in newest-first order), pick newest-wins per key, write the merged set as a single new file at `newLevel`, then delete the consumed files.
    private async mergeFiles(files: BulkFileInfo[], newLevel: number): Promise<void> {
        const storage = await this.storage();
        const readers = await Promise.all(files.map(f => this.loadFileReader(f.fileName)));

        const seen = new Set<string>();
        const mergedRows: Record<string, unknown>[] = [];
        for (const reader of readers) {
            const colData: Record<string, unknown[]> = {};
            for (const col of reader.columns) {
                colData[col.column] = (await reader.getColumn(col.column)).map(r => r.value);
            }
            for (let i = 0; i < reader.keys.length; i++) {
                const key = reader.keys[i];
                if (seen.has(key)) continue;
                seen.add(key);
                const row: Record<string, unknown> = {};
                for (const col of reader.columns) {
                    row[col.column] = colData[col.column][i];
                }
                mergedRows.push(row);
            }
        }

        await storage.set(newFileName(newLevel), encodeCompressedBlocks(buildFileBuffer(mergedRows)));
        for (const f of files) {
            await storage.remove(f.fileName);
        }
    }

    private formatInfo(reader: BaseBulkDatabaseReader): string {
        return `(collection has ${blue(formatNumber(reader.rowCount))} rows, ${blue(formatNumber(reader.totalBytes))}B)`;
    }

    // Applies the overlay (pending writes/deletes) on top of a base column. No-op when empty.
    private patchColumn(base: { key: string; value: unknown }[], column: string): { key: string; value: unknown }[] {
        if (this.overlay.size === 0) return base;
        const map = new Map(base.map(e => [e.key, e.value]));
        for (const [key, entry] of this.overlay) {
            if (entry.value === DELETED) map.delete(key);
            else map.set(key, entry.value[column]);
        }
        return [...map].map(([key, value]) => ({ key, value }));
    }

    // ---- async reads (overlay-aware) ----

    public async getSingleField<Column extends keyof T>(key: string, column: Column): Promise<T[Column] | undefined> {
        void this.syncSetup();
        const entry = this.overlay.get(key);
        if (entry !== undefined) {
            if (entry.value === DELETED) return undefined;
            return entry.value[String(column)] as T[Column];
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

    // ---- sync (observable) reads ----
    // These read the observable overlay + loadVersion, so a component that reads them re-renders when
    // a write/delete happens or when a base value finishes loading. The immutable base column/field is
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
            runInAction(() => {
                this.baseColumns.set(column, base);
                this.baseColumnsLoading.delete(column);
                this.loadVersion.set(this.loadVersion.get() + 1);
            });
        })();
    }

    private ensureBaseField(key: string, column: string) {
        let cacheKey = `${column}\u0000${key}`;
        if (this.baseFields.has(cacheKey) || this.baseFieldsLoading.has(cacheKey)) return;
        this.baseFieldsLoading.add(cacheKey);
        void (async () => {
            let reader = await this.reader();
            let value = await reader.getSingleField(key, column);
            runInAction(() => {
                this.baseFields.set(cacheKey, value);
                this.baseFieldsLoading.delete(cacheKey);
                this.loadVersion.set(this.loadVersion.get() + 1);
            });
        })();
    }

    public getSingleFieldSync<Column extends keyof T>(config: { key: string; column: Column }): T[Column] | undefined {
        void this.syncSetup();
        this.loadVersion.get();
        let { key, column } = config;
        let col = String(column);
        let entry = this.overlay.get(key);
        if (entry !== undefined) {
            if (entry.value === DELETED) return undefined;
            return entry.value[col] as T[Column];
        }
        let cacheKey = `${col}\u0000${key}`;
        if (!this.baseFields.has(cacheKey)) {
            this.ensureBaseField(key, col);
            return undefined;
        }
        return this.baseFields.get(cacheKey) as T[Column] | undefined;
    }

    public getColumnSync<Column extends keyof T>(column: Column): { key: string; value: T[Column] }[] | undefined {
        void this.syncSetup();
        this.loadVersion.get();
        let col = String(column);
        let base = this.baseColumns.get(col);
        if (!base) {
            this.ensureBaseColumn(col);
            // Track the overlay so we recompute once the base arrives or the overlay changes.
            void this.overlay.size;
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
            const result: { key: string; value: unknown }[] = [];
            const taken = new Set<string>();
            for (const db of databases) {
                // NOTE: This is annoying logic that's needed so that if the column is removed and you write to it, it will clobber the old value. Otherwise, if we just start making something undefined, it might not clobber the old value because the column wouldn't exist. Ugh...
                let values: unknown[] | undefined;
                if (db.columns.some(c => c.column === column)) {
                    values = (await db.getColumn(column)).map(r => r.value);
                }
                for (let i = 0; i < db.keys.length; i++) {
                    const key = db.keys[i];
                    if (taken.has(key) || deleted.has(key)) continue;
                    taken.add(key);
                    result.push({ key, value: values && values[i] });
                }
            }
            return result;
        },
        async getSingleField(key, column) {
            if (deleted.has(key)) return undefined;
            for (let i = 0; i < databases.length; i++) {
                if (!keySets[i].has(key)) continue;
                if (!databases[i].columns.some(c => c.column === column)) return undefined;
                return await databases[i].getSingleField(key, column);
            }
            return undefined;
        },
    };
}
