import type { FileStorage } from "../FileFolderAPI";
import { ABSENT, BaseBulkDatabaseReader, EMPTY_BUFFER, KEY_COLUMN, loadBulkDatabase } from "./BulkDatabaseFormat";
import { blockCache, GetRange } from "./blockCache";
import { STREAM_EXTENSION, StreamEntry, parseStream, streamReaderFromEntries } from "./streamLog";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { blue, red } from "socket-function/src/formatting/logColors";

export type BulkFileInfo = { fileName: string; level: number; timestamp: number };
export type StreamFileInfo = { fileName: string; timestamp: number };
export type StreamReaderCacheEntry = { readSize: number; parsedPos: number; entries: StreamEntry[] };

export class MissingFileError extends Error { }
class FilesChangedError extends Error { }

export type ResolvedReader = {
    rowCount: number;
    totalBytes: number;
    keys: string[];
    rawKeyCount: number;
    readerCount: number;
    columns: { column: string; byteSize: number }[];
    keyTimes: Map<string, number>;
    deleteTimes: Map<string, number>;
    getColumn: (column: string) => Promise<{ key: string; value: unknown; time: number }[]>;
    getSingleField: (key: string, column: string) => Promise<{ value: unknown; time: number } | undefined>;
};

export type SubReaderCaches = {
    bulk: Map<string, BaseBulkDatabaseReader>;
    stream: Map<string, StreamReaderCacheEntry>;
};

const MAX_READ_ATTEMPTS = 8;

function nullJoin(a: string, b: string): string {
    return a + String.fromCharCode(0) + b;
}

// A loaded snapshot of one collection's on-disk state: the resolved reader + the per-file decoded sub-
// readers it stitched, the stream file sizes/times it observed, and the sync (reactive) caches that
// surface column/field reads. Built once via LoadedIndex.build — eagerly, so the swap into a fresh
// LoadedIndex never blocks a read on a synchronous rebuild.
export class LoadedIndex<T extends { key: string }> {
    private constructor(
        public readonly name: string,
        public readonly storage: FileStorage,
        public readonly bulkFiles: BulkFileInfo[],
        public readonly streamFiles: StreamFileInfo[],
        public readonly reader: ResolvedReader,
        public readonly streamTimes: Map<string, number>,
        public readonly streamSizes: Map<string, number>,
        public readonly streamRowsOnDisk: number,
        public readonly streamBytesOnDisk: number,
        public readonly subCaches: SubReaderCaches,
    ) {
        this.keys = new Set(reader.keys);
        this.fileSet = new Set([...bulkFiles.map(f => f.fileName), ...streamFiles.map(f => f.fileName)]);
    }

    public readonly keys: Set<string>;
    public readonly fileSet: Set<string>;

    private baseColumns = new Map<string, { key: string; value: unknown; time: number }[]>();
    private baseColumnsLoading = new Set<string>();
    private baseFields = new Map<string, { value: unknown; time: number } | undefined>();
    private baseFieldsLoading = new Set<string>();
    // Last-known values from the previous index, served until this index loads its own fresh value, so
    // a swap doesn't flash empty in sync reads. Cleared per-entry when the fresh value lands.
    private staleBaseColumns = new Map<string, { key: string; value: unknown; time: number }[]>();
    private staleBaseFields = new Map<string, { value: unknown; time: number } | undefined>();

    get totalBytes(): number { return this.reader.totalBytes; }
    get rowCount(): number { return this.reader.rowCount; }

    isLive(key: string): boolean { return this.keys.has(key); }

    static async build<T extends { key: string }>(config: {
        name: string;
        storage: FileStorage;
        bulkFiles: BulkFileInfo[];
        streamFiles: StreamFileInfo[];
        subCaches: SubReaderCaches;
        onUnreadableFile?: (file: BulkFileInfo, message: string) => Promise<void>;
    }): Promise<LoadedIndex<T>> {
        const start = Date.now();
        let { bulkFiles, streamFiles } = config;
        let attempt = 0;
        while (true) {
            const tolerateMissing = attempt >= MAX_READ_ATTEMPTS;
            try {
                let filesChanged = false;
                const [bulkReadersRaw, streamData] = await Promise.all([
                    Promise.all(bulkFiles.map(async f => {
                        try {
                            return await loadFileReader(config.name, config.storage, f, config.subCaches.bulk);
                        } catch (e) {
                            if (e instanceof MissingFileError) { filesChanged = true; return undefined; }
                            if (config.onUnreadableFile) await config.onUnreadableFile(f, (e as Error).message);
                            return undefined;
                        }
                    })),
                    loadStreamEntries(config.name, config.storage, streamFiles, config.subCaches.stream),
                ]);
                if (streamData.missing) filesChanged = true;
                if (filesChanged && !tolerateMissing) throw new FilesChangedError();

                const bulkReaders = bulkReadersRaw.filter((r): r is BaseBulkDatabaseReader => !!r);
                const readers: BaseBulkDatabaseReader[] = [];
                let streamTimes = new Map<string, number>();
                const ordered = orderStreamEntries(streamData.entries);
                if (ordered.length) {
                    const stream = streamReaderFromEntries(ordered, streamData.totalBytes);
                    readers.push(stream.reader);
                    streamTimes = stream.times;
                }
                readers.push(...bulkReaders);
                const reader = joinBulkDatabases(readers);

                pruneSubCaches(bulkFiles, streamFiles, config.subCaches);

                const elapsed = Date.now() - start;
                if (elapsed > 50) {
                    let bytesRead = streamData.totalBytes;
                    for (const r of bulkReaders) bytesRead += r.columns.find(c => c.column === KEY_COLUMN)?.byteSize ?? 0;
                    console.log(`${blue(config.name)} loaded in ${red(formatTime(elapsed))} (${blue(formatNumber(reader.rowCount))} rows, ${bulkFiles.length} bulk + ${streamFiles.length} stream files, read ${blue(formatNumber(bytesRead))}B)`);
                }

                return new LoadedIndex<T>(
                    config.name,
                    config.storage,
                    bulkFiles,
                    streamFiles,
                    reader,
                    streamTimes,
                    streamData.sizes,
                    streamData.entries.length,
                    streamData.totalBytes,
                    config.subCaches,
                );
            } catch (e) {
                if (e instanceof FilesChangedError) {
                    attempt++;
                    continue;
                }
                throw e;
            }
        }
    }

    // Adopts the previous index's loaded base values as STALE on this one, so a sync read mid-swap can
    // serve the old value (patched with the current overlay) instead of flashing empty while the fresh
    // load runs. Per-entry: dropped when the fresh value lands here.
    inheritStaleFrom(prev: LoadedIndex<T>): void {
        for (const [k, v] of prev.baseColumns) this.staleBaseColumns.set(k, v);
        for (const [k, v] of prev.staleBaseColumns) if (!this.staleBaseColumns.has(k)) this.staleBaseColumns.set(k, v);
        for (const [k, v] of prev.baseFields) this.staleBaseFields.set(k, v);
        for (const [k, v] of prev.staleBaseFields) if (!this.staleBaseFields.has(k)) this.staleBaseFields.set(k, v);
    }

    async getColumn(column: string): Promise<{ key: string; value: unknown; time: number }[]> {
        return this.reader.getColumn(column);
    }

    async getSingleField(key: string, column: string): Promise<{ value: unknown; time: number } | undefined> {
        return this.reader.getSingleField(key, column);
    }

    ensureBaseColumn(column: string, onLoaded: () => void): void {
        if (this.baseColumns.has(column) || this.baseColumnsLoading.has(column)) return;
        this.baseColumnsLoading.add(column);
        void (async () => {
            try {
                const value = await this.reader.getColumn(column);
                this.baseColumns.set(column, value);
                this.staleBaseColumns.delete(column);
                this.baseColumnsLoading.delete(column);
                onLoaded();
            } catch (e) {
                this.baseColumnsLoading.delete(column);
                console.warn(`${this.name}.getColumnSync(${JSON.stringify(column)}) load failed, will retry: ${(e as Error).message}`);
            }
        })();
    }

    ensureBaseField(key: string, column: string, onLoaded: () => void): void {
        const ck = nullJoin(column, key);
        if (this.baseFields.has(ck) || this.baseFieldsLoading.has(ck)) return;
        this.baseFieldsLoading.add(ck);
        void (async () => {
            try {
                const value = await this.reader.getSingleField(key, column);
                this.baseFields.set(ck, value);
                this.staleBaseFields.delete(ck);
                this.baseFieldsLoading.delete(ck);
                onLoaded();
            } catch (e) {
                this.baseFieldsLoading.delete(ck);
                console.warn(`${this.name}.getSingleFieldSync(${JSON.stringify(key)}, ${JSON.stringify(column)}) load failed, will retry: ${(e as Error).message}`);
            }
        })();
    }

    // Returns the loaded value (fresh if available, else last-known stale) for the column, or undefined
    // if neither is present yet. The boolean indicates whether the returned value is fresh; callers may
    // skip caching a stale value.
    getBaseColumn(column: string): { entries: { key: string; value: unknown; time: number }[]; fresh: boolean } | undefined {
        const fresh = this.baseColumns.get(column);
        if (fresh) return { entries: fresh, fresh: true };
        const stale = this.staleBaseColumns.get(column);
        if (stale) return { entries: stale, fresh: false };
        return undefined;
    }

    getBaseField(key: string, column: string): { value: { value: unknown; time: number } | undefined; fresh: boolean; loaded: boolean } {
        const ck = nullJoin(column, key);
        if (this.baseFields.has(ck)) return { value: this.baseFields.get(ck), fresh: true, loaded: true };
        if (this.staleBaseFields.has(ck)) return { value: this.staleBaseFields.get(ck), fresh: false, loaded: true };
        return { value: undefined, fresh: false, loaded: false };
    }

    isBaseColumnLoaded(column: string): boolean {
        return this.baseColumns.has(column) || this.staleBaseColumns.has(column);
    }

    isBaseFieldLoaded(key: string, column: string): boolean {
        const ck = nullJoin(column, key);
        return this.baseFields.has(ck) || this.staleBaseFields.has(ck);
    }

    // Drops in-memory loaded values for this index, so a subsequent read reloads fresh from disk. Used
    // by reloadFromDisk() — a hard reset, no stale fallback survives.
    dropLoadedValues(): void {
        this.baseColumns.clear();
        this.baseColumnsLoading.clear();
        this.baseFields.clear();
        this.baseFieldsLoading.clear();
        this.staleBaseColumns.clear();
        this.staleBaseFields.clear();
    }
}

export async function makeRawGetRange(storage: FileStorage, fileName: string): Promise<{ rawGetRange: GetRange; size: number }> {
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

export async function loadFileReader(name: string, storage: FileStorage, f: BulkFileInfo, cache: Map<string, BaseBulkDatabaseReader>): Promise<BaseBulkDatabaseReader> {
    const cached = cache.get(f.fileName);
    if (cached) return cached;
    const raw = await makeRawGetRange(storage, f.fileName);
    const fileId = nullJoin(name, f.fileName);
    const opened = await blockCache.open(fileId, raw.size, raw.rawGetRange);
    const reader = await loadBulkDatabase({ totalBytes: opened.uncompressedSize, getRange: opened.getRange, name: f.fileName });
    cache.set(f.fileName, reader);
    return reader;
}

export async function loadStreamEntries(
    name: string,
    storage: FileStorage,
    streamFiles: StreamFileInfo[],
    cache: Map<string, StreamReaderCacheEntry>,
): Promise<{ entries: { time: number; fileName: string; entry: StreamEntry }[]; totalBytes: number; missing: boolean; sizes: Map<string, number> }> {
    const sizes = new Map<string, number>();
    if (!streamFiles.length) return { entries: [], totalBytes: 0, missing: false, sizes };
    let missing = false;
    const perFile = await Promise.all(streamFiles.map(async (f): Promise<{ fileName: string; size: number; entries: StreamEntry[] } | undefined> => {
        try {
            const info = await storage.getInfo(f.fileName);
            if (!info) { missing = true; return undefined; }
            const size = info.size;
            sizes.set(f.fileName, size);
            const cached = cache.get(f.fileName);
            if (cached && cached.readSize === size) return { fileName: f.fileName, size, entries: cached.entries };
            if (size === 0) { cache.set(f.fileName, { readSize: 0, parsedPos: 0, entries: [] }); return { fileName: f.fileName, size: 0, entries: [] }; }
            // Append-only: a larger size means new bytes at the tail, parse only those.
            if (cached && size > cached.readSize) {
                const suffix = await storage.getRange(f.fileName, { start: cached.parsedPos, end: size });
                if (!suffix) { missing = true; return undefined; }
                const parsed = parseStream(suffix);
                if (parsed.badBytes > 0) console.warn(`${name} stream file ${f.fileName} had ${parsed.badBytes} trailing bad/incomplete bytes (stopped reading there)`);
                const entries = parsed.entries.length ? cached.entries.concat(parsed.entries) : cached.entries;
                const parsedPos = cached.parsedPos + (suffix.length - parsed.badBytes);
                cache.set(f.fileName, { readSize: size, parsedPos, entries });
                return { fileName: f.fileName, size, entries };
            }
            const buffer = await storage.getRange(f.fileName, { start: 0, end: size });
            if (!buffer) { missing = true; return undefined; }
            const parsed = parseStream(buffer);
            if (parsed.badBytes > 0) console.warn(`${name} stream file ${f.fileName} had ${parsed.badBytes} trailing bad/incomplete bytes (stopped reading there)`);
            cache.set(f.fileName, { readSize: size, parsedPos: size - parsed.badBytes, entries: parsed.entries });
            return { fileName: f.fileName, size, entries: parsed.entries };
        } catch {
            missing = true;
            return undefined;
        }
    }));
    const entries: { time: number; fileName: string; entry: StreamEntry }[] = [];
    let totalBytes = 0;
    for (const pf of perFile) {
        if (!pf) continue;
        totalBytes += pf.size;
        for (const entry of pf.entries) entries.push({ time: entry.time, fileName: pf.fileName, entry });
    }
    return { entries, totalBytes, missing, sizes };
}

export function orderStreamEntries(entries: { time: number; fileName: string; entry: StreamEntry }[]): StreamEntry[] {
    entries.sort((a, b) => {
        if (a.time !== b.time) return a.time - b.time;
        return a.fileName < b.fileName && -1 || a.fileName > b.fileName && 1 || 0;
    });
    return entries.map(e => e.entry);
}

function pruneSubCaches(bulkFiles: BulkFileInfo[], streamFiles: StreamFileInfo[], subCaches: SubReaderCaches) {
    const liveBulk = new Set(bulkFiles.map(f => f.fileName));
    const liveStream = new Set(streamFiles.map(f => f.fileName));
    for (const n of subCaches.bulk.keys()) if (!liveBulk.has(n)) subCaches.bulk.delete(n);
    for (const n of subCaches.stream.keys()) if (!liveStream.has(n)) subCaches.stream.delete(n);
}

// A corrupt/unreadable column in ONE underlying file must not break the whole joined read. When a
// source's column read throws, we drop that source for that column (falling through to older readers,
// exactly as if the file never set the column) and warn once per (file, column) so the corruption is
// visible without flooding the log on every rebuild.
const warnedCorruptReads = new Set<string>();
function warnCorruptRead(db: BaseBulkDatabaseReader, column: string, e: unknown): void {
    const fileName = db.name || "(unknown source)";
    const dedupeKey = nullJoin(fileName, column);
    if (warnedCorruptReads.has(dedupeKey)) return;
    warnedCorruptReads.add(dedupeKey);
    console.warn(`${red("corrupt read")}: file ${fileName} column ${JSON.stringify(column)} could not be read - skipping it (its data is dropped from results): ${(e as Error).message}`);
}

function joinBulkDatabases(databases: BaseBulkDatabaseReader[]): ResolvedReader {
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
        rawKeyCount: databases.reduce((acc, db) => acc + db.keyTimes.size + (db.deleteTimes?.size ?? 0), 0),
        readerCount: databases.length,
        columns,
        keyTimes: keyTime,
        deleteTimes: deleteTime,
        async getColumn(column) {
            const perReader = await Promise.all(databases.map(async db => {
                if (!db.columns.some(c => c.column === column)) return undefined;
                try {
                    const entries = await db.getColumn(column);
                    return new Map(entries.map(e => [e.key, { value: e.value, time: e.time }]));
                } catch (e) {
                    warnCorruptRead(db, column, e);
                    return undefined;
                }
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
                const live = found && bestTime > delOf(key);
                return { key, value: live ? bestVal : undefined, time: live ? bestTime : (keyTime.get(key) ?? 0) };
            });
        },
        async getSingleField(key, column) {
            const kt = keyTime.get(key);
            if (kt === undefined || kt <= delOf(key)) return undefined;
            let bestTime = -Infinity;
            let bestVal: unknown;
            let found = false;
            for (const db of databases) {
                if (!db.columns.some(c => c.column === column)) continue;
                let r;
                try {
                    r = await db.getSingleField(key, column);
                } catch (e) {
                    warnCorruptRead(db, column, e);
                    continue;
                }
                if (r === ABSENT) continue;
                if (r.time > bestTime) { bestTime = r.time; bestVal = r.value; found = true; }
            }
            const live = found && bestTime > delOf(key);
            return { value: live ? bestVal : undefined, time: live ? bestTime : kt };
        },
    };
}
