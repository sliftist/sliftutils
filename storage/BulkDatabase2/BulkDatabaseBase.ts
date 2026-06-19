import { sort } from "socket-function/src/misc";
import { getTimeUnique } from "socket-function/src/bits";
import { ABSENT, BaseBulkDatabaseReader, buildFileBuffer, EMPTY_BUFFER, KEY_COLUMN, loadBulkDatabase } from "./BulkDatabaseFormat";
import { lazy } from "socket-function/src/caching";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { blue, red } from "socket-function/src/formatting/logColors";
import { blockCache, encodeCompressedBlocks, GetRange } from "./blockCache";
import { STREAM_EXTENSION, StreamEntry, frameRows, frameDeletes, parseStream, streamReaderFromEntries } from "./streamLog";
import { connect as syncConnect, broadcast as syncBroadcast, isSyncSupported, RemoteWrite } from "./syncClient";
import { Manifest, chooseManifest, isManifestName, manifestFileName, parseManifestStartTime } from "./manifest";
import { tryAcquireMergeLock, releaseMergeLock } from "./mergeLock";
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

// A single writeBatch that already exceeds these limits skips the tier-0 stream and folds straight
// into a bulk file (streaming thousands of rows one frame at a time would be pointless).
const ROLLOVER_ROWS = 5000;
const ROLLOVER_BYTES = 5 * 1024 * 1024;

// An unreadable file might be a write that is still in progress (another thread), so we can't delete
// it on sight. Once it has been unreadable for longer than this (by its filename timestamp), no
// writer is plausibly still working on it, so we delete it. Until then we just warn.
const STALE_DELETE_MS = 24 * 60 * 60 * 1000;

// All the time thresholds, mutable so tests can shrink them from hours to milliseconds. The ordering
// invariant relies on: streamSealAgeMs < foldDataAgeMs (a file is sealed well before it's foldable),
// and foldTriggerAgeMs >= foldDataAgeMs.
export const bulkDatabase2Timing = {
    // A writer stops appending to its current stream file once it's this old (starts a fresh one), so no
    // file is ever appended to past this age.
    streamSealAgeMs: 10 * 60 * 60 * 1000,
    // A fold reads every stream file CREATED longer ago than this (all sealed, with margin), and moves
    // only the entries whose WRITE-TIME is older than this into bulk; newer entries are re-streamed.
    // This single cutoff is what keeps every bulk write strictly older than every stream write.
    foldDataAgeMs: 12 * 60 * 60 * 1000,
    // We don't bother folding until some stream file is older than this (fold in big infrequent batches).
    foldTriggerAgeMs: 36 * 60 * 60 * 1000,
    // Per-instance throttle on how often we scan to see whether a fold is due.
    foldCheckIntervalMs: 5 * 1000,
    // How long a superseded/orphaned/old-manifest file must sit before cleanup deletes it (by its name
    // timestamp) — long enough that any reader still on an older manifest has finished.
    cleanupAgeMs: 60 * 1000,
    // Per-instance throttle on cleanup scans.
    cleanupIntervalMs: 10 * 1000,
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
    private lastCleanup = 0;
    private lastFoldCheck = 0;
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
        let start = Date.now();
        const { bulkFiles, streamFiles } = await this.getValidFiles();
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
        void this.cleanup(); // opportunistic, throttled, fire-and-forget — reads help GC orphans too
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

    // Resolves the authoritative on-disk state via manifests (see manifest.ts): valid bulk files
    // (newest-first) + valid stream files, plus the chosen manifest and the raw name lists the
    // commit/cleanup paths need. No manifest at all => every bulk file is valid (back-compat). Stream
    // files are valid unless the chosen manifest lists them as already folded into a bulk file.
    private async getValidFiles(): Promise<{
        bulkFiles: BulkFileInfo[];
        streamFiles: StreamFileInfo[];
        manifest: Manifest | undefined;
        manifestName: string | undefined;
        allBulkNames: string[];
        allStreamNames: string[];
        manifestNames: string[];
    }> {
        const storage = await this.storage();
        const names = await storage.getKeys();
        const manifestNames: string[] = [];
        const allBulkNames: string[] = [];
        const allStreamNames: string[] = [];
        for (const n of names) {
            if (isManifestName(n)) manifestNames.push(n);
            else if (n.endsWith(FILE_EXTENSION)) allBulkNames.push(n);
            else if (n.endsWith(STREAM_EXTENSION)) allStreamNames.push(n);
        }
        const parsed = (await Promise.all(manifestNames.map(async name => {
            try {
                const buf = await storage.get(name);
                if (!buf) return undefined;
                return { name, manifest: JSON.parse(buf.toString("utf8")) as Manifest };
            } catch {
                return undefined; // torn/corrupt/half-written manifest — ignore it
            }
        }))).filter((m): m is { name: string; manifest: Manifest } => !!m);
        const chosen = chooseManifest(parsed);

        let validBulkNames: string[];
        if (!chosen) {
            validBulkNames = allBulkNames;
        } else {
            const valid = new Set(chosen.manifest.validBulkFiles);
            validBulkNames = allBulkNames.filter(n => valid.has(n));
        }
        const ignored = new Set(chosen?.manifest.ignoredStreamFiles || []);
        const validStreamNames = allStreamNames.filter(n => !ignored.has(n));

        const bulkFiles = validBulkNames.flatMap(n => { const p = parseFileName(n); return p ? [p] : []; });
        // Newest-first by timestamp; ties broken by file name for determinism.
        bulkFiles.sort((a, b) => {
            if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
            return a.fileName < b.fileName && 1 || a.fileName > b.fileName && -1 || 0;
        });
        const streamFiles = validStreamNames.flatMap(n => { const p = parseStreamFileName(n); return p ? [p] : []; });
        sort(streamFiles, f => f.timestamp);

        return { bulkFiles, streamFiles, manifest: chosen?.manifest, manifestName: chosen?.name, allBulkNames, allStreamNames, manifestNames };
    }

    // Writes a brand-new manifest (never clobbering an existing one) capturing the full valid state.
    private async commitManifest(startTime: number, readFiles: string[], validBulkFiles: string[], ignoredStreamFiles: string[]): Promise<void> {
        const storage = await this.storage();
        const manifest: Manifest = { startTime, validBulkFiles, ignoredStreamFiles, readFiles };
        await storage.set(manifestFileName(startTime, writerId, nextCounter()), Buffer.from(JSON.stringify(manifest), "utf8"));
    }

    // Writes `rows` directly as bulk file(s), stamped with the current time as their data range (the rows
    // are being written now). Used by the large-batch write path. Commits a new manifest adding them to
    // the valid set. The rows carry time=now, so the join orders them correctly against any older stream
    // entry for the same key (newer time wins) — no clobber.
    private async writeBulkFile(rows: Record<string, unknown>[]): Promise<void> {
        const storage = await this.storage();
        const startTime = nextFileTime();
        const view = await this.getValidFiles();
        const now = Date.now();
        const times = rows.map(() => now);
        const newBulkNames: string[] = [];
        for (const buffer of buildFileBuffer(rows, times)) {
            const name = newFileName(startTime);
            await storage.set(name, encodeCompressedBlocks(buffer));
            newBulkNames.push(name);
        }
        const validBulkFiles = view.bulkFiles.map(f => f.fileName).concat(newBulkNames);
        const readFiles = [...view.allBulkNames, ...view.allStreamNames, ...view.manifestNames];
        await this.commitManifest(startTime, readFiles, validBulkFiles, view.manifest?.ignoredStreamFiles || []);
        this.resetReader();
        if (validBulkFiles.length >= MERGE_FILE_COUNT) {
            while (await this.mergeFiles() > 0) { /* consolidate accumulated bulk files */ }
        }
        await this.cleanup();
    }

    // Fold. Reads every stream file CREATED before the cutoff (all sealed, since seal age < fold age),
    // resolves them into one bulk file carrying each key's latest write-time per row, and re-persists
    // surviving tombstones to a fresh stream file (so deletes of keys living in older bulk files keep
    // suppressing them). Because reads resolve by write-time, the folded data needn't be older than the
    // stream — the join sorts it out — so we just fold whole files, no cutoff split. Folded files are
    // marked ignored (cleanup deletes them later); the new manifest is the atomic swap.
    private async consolidate(): Promise<void> {
        const storage = await this.storage();
        const startTime = nextFileTime();
        const view = await this.getValidFiles();
        const cutoff = Date.now() - bulkDatabase2Timing.foldDataAgeMs;
        const selected = view.streamFiles.filter(f => f.timestamp < cutoff);
        if (!selected.length) return;
        const { entries } = await this.loadStreamEntries(selected);
        const ordered = this.orderStreamEntries(entries);

        const byKey = new Map<string, Record<string, unknown>>();
        const byKeyTime = new Map<string, number>();
        const deleted = new Map<string, number>();
        for (const e of ordered) {
            if (e.deletedKey !== undefined) {
                byKey.delete(e.deletedKey);
                byKeyTime.delete(e.deletedKey);
                deleted.set(e.deletedKey, e.time);
            } else if (e.row) {
                const key = e.row.key as string;
                byKey.set(key, { ...byKey.get(key), ...e.row });
                byKeyTime.set(key, e.time); // ordered ascending, so this ends up the latest write
                deleted.delete(key);
            }
        }

        const newBulkNames: string[] = [];
        if (byKey.size) {
            const rows = [...byKey.values()];
            const times = rows.map(r => byKeyTime.get(r.key as string)!);
            for (const buffer of buildFileBuffer(rows, times)) {
                const name = newFileName(startTime);
                await storage.set(name, encodeCompressedBlocks(buffer));
                newBulkNames.push(name);
            }
        }

        // Surviving tombstones -> a fresh stream file (always valid). Written BEFORE the manifest so the
        // folded sources are never ignored while their deletes are missing.
        if (deleted.size) {
            const carryName = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${STREAM_EXTENSION}`;
            await storage.set(carryName, frameDeletes([...deleted].map(([key, time]) => ({ time, key }))));
        }

        const validBulkFiles = view.bulkFiles.map(f => f.fileName).concat(newBulkNames);
        const ignoredStreamFiles = [...new Set([...(view.manifest?.ignoredStreamFiles || []), ...selected.map(f => f.fileName)])];
        const readFiles = [...view.allBulkNames, ...view.allStreamNames, ...view.manifestNames];
        await this.commitManifest(startTime, readFiles, validBulkFiles, ignoredStreamFiles);
        this.resetReader();

        if (validBulkFiles.length >= MERGE_FILE_COUNT) {
            while (await this.mergeFiles() > 0) { /* consolidate accumulated bulk files */ }
        }
        await this.cleanup();
    }

    // Reads and parses every stream file in parallel. Returns per-write entries (each carrying its
    // unique timestamp + originating file) so callers can order writes globally across files.
    private async loadStreamEntries(streamFiles: StreamFileInfo[]): Promise<{ entries: { time: number; fileName: string; entry: StreamEntry }[]; totalBytes: number }> {
        if (!streamFiles.length) return { entries: [], totalBytes: 0 };
        const storage = await this.storage();
        // Read a bounded prefix [0, size) rather than the whole file: a foreign writer may be appending
        // concurrently, and storage.get() errors when the file grows past the size it stat'd. Reading a
        // prefix is tolerant — parseStream stops at the last complete frame, the file stays valid, and a
        // later read picks up the rest. A file removed out from under us (cleanup) just yields undefined.
        const buffers = await Promise.all(streamFiles.map(async f => {
            try {
                const info = await storage.getInfo(f.fileName);
                if (!info || info.size === 0) return undefined;
                return await storage.getRange(f.fileName, { start: 0, end: info.size });
            } catch {
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

    // Folding is purely age-driven and done in big infrequent batches: once some stream file is older
    // than the trigger age, fold everything past the data cutoff. Throttled so we don't scan on every write.
    private async maybeRolloverStream(): Promise<void> {
        const now = Date.now();
        if (now - this.lastFoldCheck < bulkDatabase2Timing.foldCheckIntervalMs) return;
        this.lastFoldCheck = now;
        const { streamFiles } = await this.getValidFiles();
        if (streamFiles.some(f => now - f.timestamp >= bulkDatabase2Timing.foldTriggerAgeMs)) {
            await this.consolidate();
        }
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

    // Merges exactly the files it's given, returning the new file name(s). It does NOT delete the inputs
    // or write a manifest — the caller (mergeFiles) commits one manifest for the whole pass. The merge is
    // per-COLUMN by write-TIME: for each key, each column takes the value with the newest write-time
    // across the merged files (non-ABSENT), and the output row's time is the newest of those — so the
    // merge preserves correct time-resolution (only collapsing per-column times within a single output
    // row, the accepted per-row corner). The caller keeps the input under MERGE_MAX_BYTES.
    private async mergeFilesBase(files: BulkFileInfo[], timestamp: number): Promise<string[]> {
        const storage = await this.storage();
        const readers = await Promise.all(files.map(f => this.loadFileReader(f.fileName)));

        const loaded = await Promise.all(readers.map(async reader => {
            const cols = new Map<string, Map<string, { value: unknown; time: number }>>();
            for (const col of reader.columns) {
                if (col.column === KEY_COLUMN) continue;
                const entries = await reader.getColumn(col.column);
                cols.set(col.column, new Map(entries.map(e => [e.key, { value: e.value, time: e.time }])));
            }
            return { keyTimes: reader.keyTimes, cols };
        }));

        const allKeys = new Set<string>();
        const allCols = new Set<string>();
        for (const l of loaded) {
            for (const k of l.keyTimes.keys()) allKeys.add(k);
            for (const c of l.cols.keys()) allCols.add(c);
        }

        const mergedRows: Record<string, unknown>[] = [];
        const mergedTimes: number[] = [];
        for (const key of allKeys) {
            const row: Record<string, unknown> = { [KEY_COLUMN]: key };
            let rowTime = -Infinity;
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
            for (const l of loaded) { const t = l.keyTimes.get(key); if (t !== undefined && t > rowTime) rowTime = t; }
            mergedRows.push(row);
            mergedTimes.push(rowTime === -Infinity ? 0 : rowTime);
        }

        const names: string[] = [];
        for (const buffer of buildFileBuffer(mergedRows, mergedTimes)) {
            const name = newFileName(timestamp);
            await storage.set(name, encodeCompressedBlocks(buffer));
            names.push(name);
        }
        return names;
    }

    // The cap-aware merge planner. Walks the valid files newest-first and merges contiguous runs of
    // non-sealed files, each run capped at MERGE_MAX_BYTES of LOGICAL size so a single merge never
    // loads more than that into memory. A file at/over MERGE_MIN_BYTES is sealed (left untouched) and
    // breaks the run, as does an unreadable file. The whole pass is committed as ONE new manifest:
    // valid bulk = (old valid - consumed) + merged outputs; the consumed files are left on disk for
    // cleanup. Returns the number of runs merged (0 means nothing left to consolidate).
    private async mergeFiles(): Promise<number> {
        // Best-effort cross-tab lock: if another tab is already merging, skip — the manifest backstop
        // keeps us correct, and we'd only be racing to orphan each other's output. No-op in Node.
        if (!tryAcquireMergeLock(this.name, writerId)) return 0;
        try {
            return await this.mergeFilesLocked();
        } finally {
            releaseMergeLock(this.name, writerId);
        }
    }

    private async mergeFilesLocked(): Promise<number> {
        const startTime = nextFileTime();
        const view = await this.getValidFiles();
        const files = view.bulkFiles;
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
        if (!batches.length) return 0;

        const removed = new Set<string>();
        const newBulkNames: string[] = [];
        for (const runFiles of batches) {
            // batch[0] is the newest file in each (newest-first) run, so its timestamp is the run's slot.
            const produced = await this.mergeFilesBase(runFiles, runFiles[0].timestamp);
            for (const f of runFiles) removed.add(f.fileName);
            newBulkNames.push(...produced);
        }
        const validBulkFiles = files.map(f => f.fileName).filter(n => !removed.has(n)).concat(newBulkNames);
        const ignoredStreamFiles = view.manifest?.ignoredStreamFiles || [];
        const readFiles = [...view.allBulkNames, ...view.allStreamNames, ...view.manifestNames];
        await this.commitManifest(startTime, readFiles, validBulkFiles, ignoredStreamFiles);
        this.resetReader();
        await this.cleanup();
        return batches.length;
    }

    // Deletes files no longer referenced by the authoritative manifest that have sat long enough that
    // no reader still resolving an older manifest needs them: superseded/orphaned bulk files,
    // folded-away (ignored) stream files, and every manifest but the newest. Age-gated by each file's
    // own name timestamp and throttled per instance. Best-effort — a failed remove (another writer beat
    // us to it) is ignored. We never delete a file whose name we can't parse for an age.
    private async cleanup(): Promise<void> {
        const now = Date.now();
        if (now - this.lastCleanup < bulkDatabase2Timing.cleanupIntervalMs) return;
        this.lastCleanup = now;
        // Best-effort and must never throw: it runs fire-and-forget from reads, and the directory could
        // even be removed out from under us (e.g. the collection is being deleted) mid-scan.
        try {
            const storage = await this.storage();
            const view = await this.getValidFiles();
            const validBulk = new Set(view.bulkFiles.map(f => f.fileName));
            const validStream = new Set(view.streamFiles.map(f => f.fileName));
            const remove = async (name: string) => { try { await storage.remove(name); } catch { /* already gone */ } };

            for (const name of view.allBulkNames) {
                if (validBulk.has(name)) continue;
                const info = parseFileName(name);
                if (!info || now - info.timestamp < bulkDatabase2Timing.cleanupAgeMs) continue;
                await remove(name);
            }
            for (const name of view.allStreamNames) {
                if (validStream.has(name)) continue;
                const info = parseStreamFileName(name);
                if (!info || now - info.timestamp < bulkDatabase2Timing.cleanupAgeMs) continue;
                await remove(name);
            }
            for (const name of view.manifestNames) {
                if (name === view.manifestName) continue;
                const startTime = parseManifestStartTime(name);
                if (startTime === undefined || now - startTime < bulkDatabase2Timing.cleanupAgeMs) continue;
                await remove(name);
            }
        } catch {
            // ignore — cleanup is opportunistic; the next pass will catch up
        }
    }

    private formatInfo(reader: ResolvedReader): string {
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

// The merged, time-resolved view over all readers. getColumn/getSingleField return plain resolved
// values (not {value,time}); the base layers the overlay on top of these.
type ResolvedReader = {
    rowCount: number;
    totalBytes: number;
    keys: string[];
    columns: { column: string; byteSize: number }[];
    getColumn: (column: string) => Promise<{ key: string; value: unknown }[]>;
    getSingleField: (key: string, column: string) => Promise<unknown | undefined>;
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
                return { key, value: (found && bestTime > delOf(key)) ? bestVal : undefined };
            });
        },
        async getSingleField(key, column) {
            let bestTime = -Infinity;
            let bestVal: unknown;
            let found = false;
            for (const db of databases) {
                if (!db.columns.some(c => c.column === column)) continue;
                const r = await db.getSingleField(key, column);
                if (r === ABSENT) continue;
                if (r.time > bestTime) { bestTime = r.time; bestVal = r.value; found = true; }
            }
            return (found && bestTime > delOf(key)) ? bestVal : undefined;
        },
    };
}
