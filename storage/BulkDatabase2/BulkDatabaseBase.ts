import { sort } from "socket-function/src/misc";
import { getTimeUnique } from "socket-function/src/bits";
import { lazy } from "socket-function/src/caching";
import { isNode } from "typesafecss";
import type { FileStorage } from "../FileFolderAPI";
import {
    BaseBulkDatabaseReader,
    BulkHeaderInfo,
    buildFileBuffer,
    loadBulkHeader,
    TARGET_FILE_BYTES,
} from "./BulkDatabaseFormat";
import { runPlannedMerge } from "./BulkDatabaseMerge";
import { blockCache, encodeCompressedBlocks } from "./blockCache";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { blue } from "socket-function/src/formatting/logColors";
import { STREAM_EXTENSION, frameDeletes, frameRows, streamReaderFromEntries } from "./streamLog";
import { broadcast as syncBroadcast, broadcastSeal as syncBroadcastSeal, connect as syncConnect, isSyncSupported, RemoteWrite } from "./syncClient";
import { DELETED } from "./WriteOverlay";
import { releaseMergeLock, tryAcquireMergeLock } from "./mergeLock";
import {
    BulkFileInfo,
    LoadedIndex,
    loadFileReader,
    loadStreamEntries,
    makeRawGetRange,
    MissingFileError,
    orderStreamEntries,
    StreamFileInfo,
    SubReaderCaches,
} from "./LoadedIndex";
import { BulkDatabaseReader, nullJoin } from "./BulkDatabaseReader";

export const BULK_ROOT_FOLDER = "bulkDatabases2";
const FILE_EXTENSION = ".bulk";
const ROLLOVER_ROWS = 5000;
const ROLLOVER_BYTES = 5 * 1024 * 1024;
const MEMORY_WATCHDOG_INTERVAL_MS = 60 * 1000;
const STALE_DELETE_MS = 24 * 60 * 60 * 1000;
const MAX_INDEX_RELOAD_ATTEMPTS = 3;
const FIRST_MERGE_BYTES = TARGET_FILE_BYTES / 2;
const KEY_GROUP_BYTES = 800 * 1024 * 1024;
const DUP_THRESHOLD = 0.4;
const WRITE_FLUSH_FIRST_STEP_MS = 250;

export const bulkDatabase2Timing = {
    streamSealAgeMs: 10 * 60 * 60 * 1000,
    mergeCheckIntervalMs: 30 * 60 * 1000,
    mergeSpacingMs: 5 * 60 * 1000,
    firstMergeTriggerFiles: 20,
    firstMergeTriggerRangeMs: 3 * 24 * 60 * 60 * 1000,
    streamFoldTriggerRows: 100,
    streamFoldTriggerBytes: 64 * 1024 * 1024,
    streamFileMaxBytes: 50 * 1024 * 1024,
    streamFoldHardLimitBytes: 768 * 1024 * 1024,
    // 0 = flush every write (Node — append is real and cheap); browser ramps to 15s to avoid rewriting
    // the whole stream file per write.
    writeFlushMaxDelayMs: isNode() ? 0 : 15 * 1000,
    fileSetPollIntervalMs: 30 * 60 * 1000,
    memoryFlushHeapBytes: 1500 * 1024 * 1024,
    memoryFlushMinCollectionBytes: 100 * 1024 * 1024,
    memoryFlushThrottleMs: 15 * 60 * 1000,
};

function fmtBytes(n: number): string {
    if (n < 1024) return n + "B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + "GB";
}

// Reactivity seam (no mobx dependency in this file). The mobx subclass supplies a ReactiveDeps that
// maps signal strings to its own dependency tracking; non-reactive callers pass noopReactiveDeps.
export interface ReactiveDeps {
    observe(signal: string): void;
    invalidate(signal: string): void;
    batch(fn: () => void): void;
    // Optional — lets writes skip per-key invalidation for rows nothing is watching. Undefined =
    // "assume watched".
    isObserved?(signal: string): boolean;
}

export const noopReactiveDeps: ReactiveDeps = {
    observe() { },
    invalidate() { },
    batch(fn) { fn(); },
    isObserved() { return false; },
};

export type StorageFactory = (path: string) => Promise<FileStorage>;

export type BulkDatabase2Config = {
    // See BulkDatabaseReader.cfg.maxTriggerThrottleMs.
    maxTriggerThrottleMs?: number;
};

let networkCompactionEnabled = false;

let fileNameCounter = 0;
// Per-process ID so two writers picking the same timestamp + counter never collide on a name.
const writerId = Math.random().toString(36).slice(2, 10);
function nextCounter(): number { return ++fileNameCounter; }

let lastFileTime = 0;
// Strictly-increasing integer so newest-first ordering is unambiguous within a millisecond.
function nextFileTime(): number {
    lastFileTime = Math.max(Date.now(), lastFileTime + 1);
    return lastFileTime;
}

function newFileName(timestamp: number): string {
    return `0_${timestamp}_${writerId}_${nextCounter()}${FILE_EXTENSION}`;
}

function parseStreamFileName(fileName: string): StreamFileInfo | undefined {
    if (!fileName.endsWith(STREAM_EXTENSION)) return undefined;
    const parts = fileName.slice(0, -STREAM_EXTENSION.length).split("_");
    if (parts.length !== 3 || parts[0] !== "stream") return undefined;
    const timestamp = parseInt(parts[1], 10);
    if (!Number.isFinite(timestamp)) return undefined;
    return { fileName, timestamp };
}

// Accept old 3-part (level_timestamp_counter) and new 4-part (level_timestamp_writerId_counter) shapes.
function parseFileName(fileName: string): BulkFileInfo | undefined {
    if (!fileName.endsWith(FILE_EXTENSION)) return undefined;
    const parts = fileName.slice(0, -FILE_EXTENSION.length).split("_");
    if (parts.length < 3) return undefined;
    const level = parseInt(parts[0], 10);
    const timestamp = parseInt(parts[1], 10);
    if (!Number.isFinite(level) || !Number.isFinite(timestamp)) return undefined;
    return { fileName, level, timestamp };
}

export class BulkDatabaseBase<T extends { key: string }> {
    constructor(
        public readonly name: string,
        protected deps: ReactiveDeps,
        private storageFactory: StorageFactory,
        private config: BulkDatabase2Config = {},
    ) {
        this.reader = new BulkDatabaseReader<T>({
            name,
            deps,
            maxTriggerThrottleMs: config.maxTriggerThrottleMs,
        });
        this.reader.setEnsureIndex(() => this.ensureIndex());

        if (typeof window !== "undefined") {
            try {
                window.addEventListener("pagehide", () => void this.flushPending());
                if (typeof document !== "undefined") {
                    document.addEventListener("visibilitychange", () => {
                        if (document.visibilityState === "hidden") void this.flushPending();
                    });
                }
            } catch { /* not in a DOM context */ }
        }
        this.fileSetPollTimer = setInterval(() => void this.pollFileSet(), bulkDatabase2Timing.fileSetPollIntervalMs);
        (this.fileSetPollTimer as { unref?: () => void }).unref?.();
        BulkDatabaseBase.liveInstances.add(this);
        BulkDatabaseBase.startMemoryWatchdog();
    }

    private reader: BulkDatabaseReader<T>;
    private subCaches: SubReaderCaches = { bulk: new Map(), stream: new Map() };

    private pendingAppends: { framed: Buffer; rows: number }[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | undefined;
    private flushChain: Promise<void> = Promise.resolve();
    private currentFlushDelay = 0;
    private lastWriteTime = 0;

    private streamFileName: string | undefined;
    private currentStreamFileName: string | undefined;
    private currentStreamFileBytes = 0;
    private lastMergeCheck = Date.now();
    // Running counters of stream-tier rows + bytes on disk. Seeded from each LoadedIndex build, then
    // incremented per flush so the fold-trigger checks current data without an extra directory listing.
    private streamRowsOnDisk = 0;
    private streamBytesOnDisk = 0;

    private fileSetPollTimer: ReturnType<typeof setInterval> | undefined;
    private rebuildPromise: Promise<void> | undefined;
    private rebuildDirty = false;
    private rebuildOptions: { dropStaleFallback: boolean } = { dropStaleFallback: false };

    // ── memory-pressure watchdog (global, browser-only) ──
    private static liveInstances = new Set<BulkDatabaseBase<{ key: string }>>();
    private static memoryWatchdogStarted = false;
    private static lastMemoryFlushMs = 0;
    private static startMemoryWatchdog() {
        if (BulkDatabaseBase.memoryWatchdogStarted) return;
        BulkDatabaseBase.memoryWatchdogStarted = true;
        const usedHeap = (): number | undefined => {
            try { return (performance as unknown as { memory?: { usedJSHeapSize?: number } })?.memory?.usedJSHeapSize; }
            catch { return undefined; }
        };
        if (typeof performance === "undefined" || usedHeap() === undefined) return;
        const timer = setInterval(() => {
            const used = usedHeap();
            if (used !== undefined) BulkDatabaseBase.checkMemoryPressure(used);
        }, MEMORY_WATCHDOG_INTERVAL_MS);
        (timer as { unref?: () => void }).unref?.();
    }
    public static checkMemoryPressure(usedHeapBytes: number): void {
        if (usedHeapBytes < bulkDatabase2Timing.memoryFlushHeapBytes) return;
        const now = Date.now();
        if (now - BulkDatabaseBase.lastMemoryFlushMs < bulkDatabase2Timing.memoryFlushThrottleMs) return;
        BulkDatabaseBase.lastMemoryFlushMs = now;
        const flushed: string[] = [];
        for (const db of BulkDatabaseBase.liveInstances) {
            const bytes = db.reader.index?.totalBytes ?? 0;
            if (bytes > bulkDatabase2Timing.memoryFlushMinCollectionBytes) {
                flushed.push(`${db.name} (${fmtBytes(bytes)})`);
                db.reloadFromDisk();
            }
        }
        if (flushed.length) console.log(`[bulk2] heap ${fmtBytes(usedHeapBytes)} over ${fmtBytes(bulkDatabase2Timing.memoryFlushHeapBytes)} — flushed ${flushed.length} large collection(s): ${flushed.join(", ")}`);
    }

    public static clearCache() {
        blockCache.clear();
    }

    public static enableNetworkCompaction() {
        networkCompactionEnabled = true;
    }

    public storage = lazy(async () => this.storageFactory(`${BULK_ROOT_FOLDER}/${this.name}`));

    public async isRemote(): Promise<boolean> {
        return !!(await this.storage()).isRemote;
    }

    private streamNeedsFold(): boolean {
        return this.streamRowsOnDisk >= bulkDatabase2Timing.streamFoldTriggerRows
            && this.streamBytesOnDisk > bulkDatabase2Timing.streamFoldTriggerBytes;
    }

    private async automaticCompactionAllowed(): Promise<boolean> {
        if (networkCompactionEnabled) return true;
        return !(await this.storage()).isRemote;
    }

    public isKeyWatched(key: string): boolean {
        return this.reader.isKeyWatched(key);
    }

    // ── index lifecycle ──────────────────────────────────────────────────────────────────────────────
    private async ensureIndex(): Promise<LoadedIndex<T>> {
        if (this.reader.index) return this.reader.index;
        await this.triggerRebuild();
        const idx = this.reader.index;
        if (!idx) throw new Error(`${this.name}: index failed to build`);
        return idx;
    }

    // Coalescing rebuild loop: triggers during a build set rebuildDirty so the loop iterates once more
    // when it finishes — N rapid triggers cause at most ONE extra rebuild after the current one ends.
    private triggerRebuild(opts: { dropStaleFallback?: boolean } = {}): Promise<void> {
        if (opts.dropStaleFallback) this.rebuildOptions.dropStaleFallback = true;
        if (this.rebuildPromise) {
            this.rebuildDirty = true;
            return this.rebuildPromise;
        }
        this.rebuildPromise = (async () => {
            try {
                do {
                    this.rebuildDirty = false;
                    await this.doOneRebuild();
                } while (this.rebuildDirty);
            } finally {
                this.rebuildPromise = undefined;
                this.rebuildOptions.dropStaleFallback = false;
            }
        })();
        return this.rebuildPromise;
    }

    private async doOneRebuild(): Promise<void> {
        const { bulkFiles, streamFiles } = await this.listFiles();
        const storage = await this.storage();
        const newIndex = await LoadedIndex.build<T>({
            name: this.name,
            storage,
            bulkFiles,
            streamFiles,
            subCaches: this.subCaches,
            onUnreadableFile: (f, msg) => this.handleUnreadableFile(f, msg),
        });
        const oldIndex = this.reader.index;
        this.reader.setIndex(newIndex, { dropStaleFallback: this.rebuildOptions.dropStaleFallback });
        this.streamRowsOnDisk = newIndex.streamRowsOnDisk;
        this.streamBytesOnDisk = newIndex.streamBytesOnDisk;
        if (oldIndex) {
            for (const f of oldIndex.fileSet) {
                if (!newIndex.fileSet.has(f)) blockCache.evict(nullJoin(this.name, f));
            }
        }
    }

    // Drop everything in-memory, hard reset. Pending un-flushed writes survive (still in overlay).
    public reloadFromDisk(): void {
        this.subCaches.bulk.clear();
        this.subCaches.stream.clear();
        this.reader.index?.dropLoadedValues();
        void this.triggerRebuild({ dropStaleFallback: true });
    }

    // External-merge detection: if some other tab/process changed the file set under us, rebuild.
    private async pollFileSet(): Promise<void> {
        if (!this.reader.index) return;
        let current: Set<string>;
        try {
            const { bulkFiles, streamFiles } = await this.listFiles();
            current = new Set([...bulkFiles.map(f => f.fileName), ...streamFiles.map(f => f.fileName)]);
        } catch { return; }
        const prev = this.reader.index?.fileSet;
        if (!prev) return;
        const changed = current.size !== prev.size || [...current].some(n => !prev.has(n));
        if (changed) void this.triggerRebuild();
    }

    private async readWithRetry<R>(fn: () => Promise<R>): Promise<R> {
        await this.ensureIndex();
        for (let attempt = 0; ; attempt++) {
            const before = this.reader.index;
            try { return await fn(); }
            catch (e) {
                if (!(e instanceof MissingFileError) || attempt >= MAX_INDEX_RELOAD_ATTEMPTS) throw e;
                if (this.reader.index === before) await this.triggerRebuild();
            }
        }
    }

    // ── cross-tab sync ───────────────────────────────────────────────────────────────────────────────
    private syncSetup = lazy(async () => {
        if (!isSyncSupported()) return;
        await this.ensureIndex();
        const recent = await syncConnect(this.name, w => this.applyRemote(w), () => { this.streamFileName = undefined; });
        for (const w of recent) this.applyRemote(w);
    });

    private applyRemote(write: RemoteWrite) {
        if (write.time <= this.reader.localTime(write.key)) return;
        this.deps.batch(() => {
            if (write.deleted) this.reader.applyDelete(write.key, write.time);
            else this.reader.applyWrite(write.key, write.value as Record<string, unknown>, write.time);
        });
    }

    // ── writes ───────────────────────────────────────────────────────────────────────────────────────
    public async write(entry: T): Promise<void> {
        return this.writeBatch([entry]);
    }

    public async writeBatch(entries: T[]): Promise<void> {
        if (!entries.length) return;
        void this.syncSetup();
        const rows = entries as unknown as Record<string, unknown>[];
        const stamped = rows.map(row => ({ time: getTimeUnique(), row }));
        const framed = frameRows(stamped);

        // Big batches skip the stream and become a bulk file directly — streaming thousands of rows
        // one frame at a time would just churn.
        if (entries.length >= ROLLOVER_ROWS || framed.length >= ROLLOVER_BYTES) {
            await this.writeBulkFile(rows);
            return;
        }

        this.deps.batch(() => {
            for (const { time, row } of stamped) this.reader.applyWrite(row.key as string, row, time);
        });
        for (const { time, row } of stamped) syncBroadcast(this.name, { key: row.key as string, time, value: row });
        await this.streamAppend(framed, stamped.length);
        void this.maybeMerge();
    }

    public async delete(key: string): Promise<void> {
        return this.deleteBatch([key]);
    }

    public async deleteBatch(keys: string[]): Promise<void> {
        if (!keys.length) return;
        void this.syncSetup();
        const stamped = keys.map(key => ({ time: getTimeUnique(), key }));
        this.deps.batch(() => {
            for (const { time, key } of stamped) this.reader.applyDelete(key, time);
        });
        for (const { time, key } of stamped) syncBroadcast(this.name, { key, time, deleted: true });
        await this.streamAppend(frameDeletes(stamped), stamped.length);
        void this.maybeMerge();
    }

    // Coalesce stream appends on a ramping per-collection schedule (the browser rewrites the whole
    // file per append). The first write after a lull flushes immediately so a single edit-then-close
    // is saved at once; sustained writes ramp toward writeFlushMaxDelayMs.
    private async streamAppend(framed: Buffer, rows: number): Promise<void> {
        this.pendingAppends.push({ framed, rows });
        const max = bulkDatabase2Timing.writeFlushMaxDelayMs;
        const now = Date.now();
        if (max <= 0 || this.currentFlushDelay <= 0 || now - this.lastWriteTime > max) {
            this.lastWriteTime = now;
            this.currentFlushDelay = max > 0 ? Math.min(max, WRITE_FLUSH_FIRST_STEP_MS) : 0;
            await this.flushPending();
            return;
        }
        this.lastWriteTime = now;
        if (this.flushTimer === undefined) {
            this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.flushPending(); }, this.currentFlushDelay);
        }
        this.currentFlushDelay = Math.min(max, this.currentFlushDelay * 2);
    }

    public async flush(): Promise<void> {
        await this.flushPending();
    }

    private async flushPending(): Promise<void> {
        if (this.flushTimer !== undefined) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
        this.flushChain = this.flushChain.then(() => this.doFlush()).catch(e => {
            console.warn(`${this.name}: stream flush failed, will retry: ${(e as Error).message}`);
        });
        return this.flushChain;
    }

    private async doFlush(): Promise<void> {
        if (!this.pendingAppends.length) return;
        const batch = this.pendingAppends.slice();
        const combined = Buffer.concat(batch.map(p => p.framed));
        const storage = await this.storage();
        const fileName = this.getStreamFileName();
        if (fileName !== this.currentStreamFileName) {
            this.currentStreamFileName = fileName;
            this.currentStreamFileBytes = 0;
        }
        // On failure the throw leaves pendingAppends intact so a later flush retries.
        await storage.append(fileName, combined);
        // New entries appended during the await are after `batch` — removing the front is exactly the
        // flushed set.
        this.pendingAppends.splice(0, batch.length);
        this.streamBytesOnDisk += combined.length;
        for (const p of batch) this.streamRowsOnDisk += p.rows;
        this.currentStreamFileBytes += combined.length;
        if (this.currentStreamFileBytes >= bulkDatabase2Timing.streamFileMaxBytes) {
            this.streamFileName = undefined;
            this.currentStreamFileName = undefined;
            this.currentStreamFileBytes = 0;
            void this.foldOwnStream(fileName);
        }
    }

    private getStreamFileName(): string {
        // Seal our current file once it ages past the seal threshold — no file is ever appended to past
        // its seal age, which lets a consolidation safely fold it once aged.
        if (this.streamFileName) {
            const info = parseStreamFileName(this.streamFileName);
            if (info && Date.now() - info.timestamp >= bulkDatabase2Timing.streamSealAgeMs) this.streamFileName = undefined;
        }
        if (!this.streamFileName) {
            this.streamFileName = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${STREAM_EXTENSION}`;
        }
        return this.streamFileName;
    }

    private async foldOwnStream(fileName: string): Promise<void> {
        const info = parseStreamFileName(fileName);
        if (!info) return;
        try {
            await this.mergeFileSet([], [info], false, true);
        } catch (e) {
            console.warn(`${this.name}: folding own stream ${fileName} failed: ${(e as Error).message}`);
        }
    }

    public async update(entry: Partial<T> & { key: string }): Promise<void> {
        return this.updateBatch([entry]);
    }

    public async updateBatch(entries: (Partial<T> & { key: string })[]): Promise<void> {
        if (!entries.length) return;
        void this.syncSetup();
        const index = await this.ensureIndex();
        const present: T[] = [];
        for (const entry of entries) {
            const overlayEntry = this.reader.overlay.get(entry.key);
            const exists = overlayEntry ? overlayEntry.value !== DELETED : index.keys.has(entry.key);
            if (!exists) {
                console.warn(`${this.name}.update: key ${JSON.stringify(entry.key)} is not in the collection, ignoring`);
                continue;
            }
            present.push(entry as unknown as T);
        }
        if (present.length) await this.writeBatch(present);
    }

    // ── file listings ────────────────────────────────────────────────────────────────────────────────
    private async listFiles(): Promise<{ bulkFiles: BulkFileInfo[]; streamFiles: StreamFileInfo[] }> {
        const storage = await this.storage();
        const names = await storage.getKeys();
        const bulkFiles: BulkFileInfo[] = [];
        const streamFiles: StreamFileInfo[] = [];
        for (const n of names) {
            if (n.endsWith(FILE_EXTENSION)) { const p = parseFileName(n); if (p) bulkFiles.push(p); }
            else if (n.endsWith(STREAM_EXTENSION)) { const p = parseStreamFileName(n); if (p) streamFiles.push(p); }
        }
        bulkFiles.sort((a, b) => {
            if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
            return a.fileName < b.fileName && 1 || a.fileName > b.fileName && -1 || 0;
        });
        sort(streamFiles, f => f.timestamp);
        return { bulkFiles, streamFiles };
    }

    private async writeBulkFile(rows: Record<string, unknown>[]): Promise<void> {
        const storage = await this.storage();
        const timestamp = nextFileTime();
        const now = Date.now();
        const times = rows.map(() => now);
        for (const built of buildFileBuffer(rows, times)) {
            const name = newFileName(timestamp);
            await storage.set(name, encodeCompressedBlocks(built.buffer));
        }
        await this.triggerRebuild();
        void this.maybeMerge();
    }

    // ── merge policy ─────────────────────────────────────────────────────────────────────────────────
    private async maybeMerge(): Promise<void> {
        if (!await this.automaticCompactionAllowed()) return;
        const now = Date.now();
        if (!this.streamNeedsFold() && now - this.lastMergeCheck < bulkDatabase2Timing.mergeCheckIntervalMs) return;
        this.lastMergeCheck = now;
        try {
            await this.tryMergeNow();
        } catch (e) {
            console.warn(`${this.name}: background merge failed: ${(e as Error).message}`);
        }
    }

    public async tryMergeNow(): Promise<{ merged: boolean; lockFailed: boolean }> {
        if (!tryAcquireMergeLock(this.name, writerId)) return { merged: false, lockFailed: true };
        try {
            return { merged: await this.testMerge(), lockFailed: false };
        } finally {
            releaseMergeLock(this.name, writerId);
        }
    }

    public async compact(): Promise<void> {
        if (!tryAcquireMergeLock(this.name, writerId)) return;
        try {
            await this.flushPending();
            syncBroadcastSeal(this.name);
            this.streamFileName = undefined;
            const { bulkFiles, streamFiles } = await this.listFiles();
            // compact() folds every file → no older data survives outside it → surviving tombstones
            // can be dropped (nothing left to suppress).
            if (bulkFiles.length + streamFiles.length >= 1) await this.mergeFileSet(bulkFiles, streamFiles, true);
        } finally {
            releaseMergeLock(this.name, writerId);
        }
    }

    public async merge(timeLo: number, timeHi: number): Promise<void> {
        if (timeHi >= Date.now()) { syncBroadcastSeal(this.name); this.streamFileName = undefined; }
        const { bulkFiles, streamFiles } = await this.listFiles();
        const headers = await Promise.all(bulkFiles.map(f => this.readBulkHeader(f.fileName)));
        const selBulk = bulkFiles.filter((f, i) => {
            const h = headers[i];
            if (!h) return false;
            if (!h.maxTime && !h.minTime) return timeLo <= 0;
            return h.minTime <= timeHi && h.maxTime >= timeLo;
        });
        const selStream = streamFiles.filter(f =>
            f.timestamp <= timeHi && f.timestamp + bulkDatabase2Timing.streamSealAgeMs >= timeLo);
        if (selBulk.length + selStream.length < 2) return;
        await this.mergeFileSet(selBulk, selStream, timeLo <= 0);
    }

    private async readBulkHeader(fileName: string): Promise<BulkHeaderInfo | undefined> {
        try {
            const storage = await this.storage();
            const raw = await makeRawGetRange(storage, fileName);
            const fileId = nullJoin(this.name, fileName);
            const opened = await blockCache.open(fileId, raw.size, raw.rawGetRange);
            return await loadBulkHeader(opened.getRange, opened.uncompressedSize);
        } catch {
            return undefined;
        }
    }

    private async fileLogicalSize(fileName: string): Promise<number | undefined> {
        try {
            const storage = await this.storage();
            const raw = await makeRawGetRange(storage, fileName);
            const fileId = nullJoin(this.name, fileName);
            const opened = await blockCache.open(fileId, raw.size, raw.rawGetRange);
            return opened.uncompressedSize;
        } catch {
            return undefined;
        }
    }

    // A bulk file that won't load is either an in-progress write (recent) or a crashed partial write
    // (stale). Warn while recent, delete once clearly abandoned — deleting is safe because the write
    // protocol always lands the replacement before removing the file it supersedes.
    private async handleUnreadableFile(file: BulkFileInfo, message: string): Promise<void> {
        const ageMs = Date.now() - file.timestamp;
        if (ageMs > STALE_DELETE_MS) {
            console.warn(`${this.name}: deleting stale unreadable bulk file ${file.fileName} (${Math.round(ageMs / 86400000)}d old): ${message}`);
            try {
                const storage = await this.storage();
                await storage.remove(file.fileName);
            } catch (removeError) {
                console.warn(`${this.name}: failed to delete ${file.fileName}: ${(removeError as Error).message}`);
            }
            return;
        }
        console.warn(`${this.name}: skipping unreadable bulk file ${file.fileName} (recent — may be in-progress): ${message}`);
    }

    // The one merge primitive. Reads + plans + writes outputs before deleting any input, so a crash
    // leaves duplicates (next merge dedupes) rather than a gap. After the file set changes on disk,
    // we trigger an index rebuild + atomic swap; once swap completes, the consumed files' block-cache
    // entries are evicted (no consumer can ask for them now).
    private async mergeFileSet(bulkFiles: BulkFileInfo[], streamFiles: StreamFileInfo[], includesOldest = false, forceDeleteStreams = false): Promise<boolean> {
        const storage = await this.storage();
        const timestamp = nextFileTime();
        const now = Date.now();

        const consumedBulk: BulkFileInfo[] = [];
        const bulkReaders: BaseBulkDatabaseReader[] = [];
        await Promise.all(bulkFiles.map(async f => {
            try {
                const r = await loadFileReader(this.name, storage, f, this.subCaches.bulk);
                bulkReaders.push(r);
                consumedBulk.push(f);
            } catch { /* missing or corrupt — skip; its data lives in another file */ }
        }));

        const streamData = await loadStreamEntries(this.name, storage, streamFiles, this.subCaches.stream);
        const ordered = orderStreamEntries(streamData.entries);
        const streamReader = ordered.length ? streamReaderFromEntries(ordered, 0).reader : undefined;

        const readers = streamReader ? [streamReader, ...bulkReaders] : bulkReaders;
        const readerNames = streamReader ? ["(streams)", ...consumedBulk.map(f => f.fileName)] : consumedBulk.map(f => f.fileName);
        if (!readers.length) return false;

        const inputs = [
            ...await Promise.all(consumedBulk.map(async f => ({ name: f.fileName, size: (await storage.getInfo(f.fileName).catch(() => undefined))?.size ?? 0 }))),
            ...streamFiles.map(f => ({ name: f.fileName, size: streamData.sizes.get(f.fileName) ?? 0 })),
        ];
        const inTotal = inputs.reduce((a, f) => a + f.size, 0);
        const mergeStartMs = Date.now();
        console.log(`${blue(this.name)} merge: reading ${inputs.length} files (${fmtBytes(inTotal)}) at ${new Date(mergeStartMs).toISOString()}`);
        for (const f of inputs) console.log(`    in  ${f.name}  ${fmtBytes(f.size)}`);

        const newNames: string[] = [];
        const mergeResult = await runPlannedMerge({
            sources: readers,
            sourceNames: readerNames,
            collectionName: this.name,
            writeFile: async (data) => {
                const fname = newFileName(timestamp);
                await storage.set(fname, encodeCompressedBlocks(data));
                newNames.push(fname);
                const size = (await storage.getInfo(fname).catch(() => undefined))?.size ?? 0;
                return { name: fname, size };
            },
        });

        const carriedDeletes = includesOldest ? 0 : mergeResult.carriedDeletes.size;
        const outNames = [...newNames];
        if (carriedDeletes) {
            const carryName = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${STREAM_EXTENSION}`;
            await storage.set(carryName, frameDeletes([...mergeResult.carriedDeletes].map(([key, time]) => ({ time, key }))));
            outNames.push(carryName);
        }

        const outputs = await Promise.all(outNames.map(async n => ({ name: n, size: (await storage.getInfo(n).catch(() => undefined))?.size ?? 0 })));
        const outTotal = outputs.reduce((a, f) => a + f.size, 0);
        console.log(`${blue(this.name)} merge: wrote ${outputs.length} files (${fmtBytes(outTotal)}, from ${fmtBytes(inTotal)})${carriedDeletes ? `, ${carriedDeletes} tombstones carried` : ""} at ${new Date().toISOString()} (took ${formatTime(Date.now() - mergeStartMs)})`);
        for (const f of outputs) console.log(`    out ${f.name}  ${fmtBytes(f.size)}`);

        const remove = async (name: string) => { try { await storage.remove(name); } catch { /* already gone */ } };
        for (const f of consumedBulk) await remove(f.fileName);
        for (const f of streamFiles) {
            if (await this.canDeleteStream(f, now, streamData.sizes, forceDeleteStreams)) await remove(f.fileName);
        }

        // File set changed — rebuild + swap. After the swap, consumed files' block-cache entries are
        // evicted (no reader will request them now).
        await this.triggerRebuild();
        return newNames.length > 0 || carriedDeletes > 0;
    }

    // A stream is safe to delete iff no writer will append to it again: it's aged past the seal age
    // (writer has provably switched files) OR cross-tab sync is on AND its size didn't change while
    // we read it. Else leave it — the data is also in the new bulk file; a later merge deletes it
    // once aged.
    private async canDeleteStream(f: StreamFileInfo, now: number, sizes: Map<string, number>, force = false): Promise<boolean> {
        if (now - f.timestamp >= bulkDatabase2Timing.streamSealAgeMs) return true;
        if (!isSyncSupported() && !force) return false;
        const readSize = sizes.get(f.fileName);
        if (readSize === undefined) return false;
        let info;
        try { info = await (await this.storage()).getInfo(f.fileName); } catch { return false; }
        return !!info && info.size === readSize;
    }

    private async mergeSpacingDelay(): Promise<boolean> {
        const total = bulkDatabase2Timing.mergeSpacingMs;
        if (total <= 0) return tryAcquireMergeLock(this.name, writerId);
        const step = 15 * 1000;
        let waited = 0;
        while (waited < total) {
            await new Promise<void>(r => setTimeout(r, Math.min(step, total - waited)));
            waited += step;
            if (!tryAcquireMergeLock(this.name, writerId)) return false;
        }
        return true;
    }

    // The merge policy (two passes, spaced by mergeSpacingMs):
    //   1) Consolidate recent fragmentation: take newest files up to ~FIRST_MERGE_BYTES; merge them
    //      into one when they fragment or span too wide a time range.
    //   2) Key-stratify: walk all keys in ~KEY_GROUP_BYTES groups; rewrite groups whose duplicate-key
    //      fraction passes DUP_THRESHOLD, highest first.
    private async testMerge(): Promise<boolean> {
        let merged = false;
        await this.flushPending();
        const runMerge = async (bulk: BulkFileInfo[], stream: StreamFileInfo[]): Promise<boolean> => {
            if (merged && !await this.mergeSpacingDelay()) return false;
            if (await this.mergeFileSet(bulk, stream)) merged = true;
            return true;
        };

        // Hard stream limit: a stream this big makes every read pull a huge file → fold ALL of it now,
        // force-delete (canDeleteStream still requires size-stable, so an active writer never loses data).
        {
            const { streamFiles } = await this.listFiles();
            if (streamFiles.length) {
                const storage = await this.storage();
                const sizes = await Promise.all(streamFiles.map(async f => { try { return (await storage.getInfo(f.fileName))?.size ?? 0; } catch { return 0; } }));
                const totalStreamBytes = sizes.reduce((a, b) => a + b, 0);
                if (totalStreamBytes > bulkDatabase2Timing.streamFoldHardLimitBytes) {
                    console.log(`${blue(this.name)} stream tier ${fmtBytes(totalStreamBytes)} over hard limit ${fmtBytes(bulkDatabase2Timing.streamFoldHardLimitBytes)} — folding all streams now`);
                    if (await this.mergeFileSet([], streamFiles, false, true)) merged = true;
                }
            }
        }

        // Pass 1: consolidate recent. Only seal when cross-tab sync can fold recent streams — in Node
        // canDeleteStream needs them aged anyway, so sealing would just fragment streams every pass.
        const foldRecentStreams = isSyncSupported();
        if (foldRecentStreams) {
            syncBroadcastSeal(this.name);
            this.streamFileName = undefined;
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
            const recentStreamBytes = recent.reduce((a, it) => a + (it.kind === "stream" ? it.bytes : 0), 0);
            const heavyStream = recentStreamBytes > bulkDatabase2Timing.streamFoldTriggerBytes;
            const triggered =
                recent.length >= 2 && (recent.length > bulkDatabase2Timing.firstMergeTriggerFiles || span > bulkDatabase2Timing.firstMergeTriggerRangeMs)
                || heavyStream;
            if (triggered) {
                const rb = recent.filter(i => i.kind === "bulk").map(i => (i.file as BulkFileInfo));
                const rs = recent.filter(i => i.kind === "stream").map(i => (i.file as StreamFileInfo));
                if (!await runMerge(rb, rs)) return merged;
            }
        }

        // Pass 2: key-stratified deduplication. Disjoint key ranges → one group's merge doesn't
        // change another's duplication; re-select each group's files at merge time (set shifts).
        const groups = await this.findDuplicateGroups();
        for (const g of groups) {
            const { bulkFiles } = await this.listFiles();
            const headers = await Promise.all(bulkFiles.map(f => this.readBulkHeader(f.fileName)));
            const groupFiles = bulkFiles.filter((f, i) => {
                const h = headers[i];
                if (!h) return false;
                if (h.minKey === undefined || h.maxKey === undefined) return true;
                return h.minKey <= g.hi && h.maxKey >= g.lo;
            });
            if (groupFiles.length >= 2) { if (!await runMerge(groupFiles, [])) return merged; }
        }

        return merged;
    }

    private async findDuplicateGroups(): Promise<{ lo: string; hi: string; dup: number }[]> {
        const { bulkFiles } = await this.listFiles();
        if (bulkFiles.length < 2) return [];
        const storage = await this.storage();
        const infos = await Promise.all(bulkFiles.map(async f => {
            try {
                const reader = await loadFileReader(this.name, storage, f, this.subCaches.bulk);
                return { keys: reader.keys, bytes: reader.totalBytes };
            } catch {
                return { keys: [] as string[], bytes: 0 };
            }
        }));
        const keyCount = new Map<string, number>();
        let totalSlots = 0, totalBytes = 0;
        for (const i of infos) {
            totalBytes += i.bytes;
            for (const k of i.keys) { keyCount.set(k, (keyCount.get(k) || 0) + 1); totalSlots++; }
        }
        if (totalSlots === 0) return [];
        const bytesPerSlot = totalBytes / totalSlots;
        const sortedKeys = [...keyCount.keys()].sort();
        const groups: { lo: string; hi: string; dup: number }[] = [];
        let gStart = 0, gBytes = 0, gSlots = 0, gUnique = 0;
        for (let i = 0; i < sortedKeys.length; i++) {
            const c = keyCount.get(sortedKeys[i]) ?? 0;
            gBytes += c * bytesPerSlot; gSlots += c; gUnique += 1;
            if (gBytes >= KEY_GROUP_BYTES || i === sortedKeys.length - 1) {
                const dup = (gSlots - gUnique) / gSlots;
                if (dup > DUP_THRESHOLD) groups.push({ lo: sortedKeys[gStart], hi: sortedKeys[i], dup });
                gStart = i + 1; gBytes = 0; gSlots = 0; gUnique = 0;
            }
        }
        groups.sort((a, b) => b.dup - a.dup);
        return groups;
    }

    // ── reads — forwarded to BulkDatabaseReader, with rebuild-on-missing retry ───────────────────────
    public async getSingleField<C extends keyof T>(key: string, column: C): Promise<T[C] | undefined> {
        void this.syncSetup();
        return this.readWithRetry(() => this.reader.getSingleField(key, column));
    }

    public async getSingleFieldObj<C extends keyof T>(key: string, column: C): Promise<{ key: string; value: T[C]; time: number } | undefined> {
        void this.syncSetup();
        return this.readWithRetry(() => this.reader.getSingleFieldObj(key, column));
    }

    public async getColumn<C extends keyof T>(column: C): Promise<{ key: string; value: T[C]; time: number }[]> {
        void this.syncSetup();
        return this.readWithRetry(() => this.reader.getColumn(column));
    }

    public async getKeys(): Promise<string[]> {
        void this.syncSetup();
        return this.readWithRetry(() => this.reader.getKeys());
    }

    public getSingleFieldSync<C extends keyof T>(key: string, column: C): T[C] | undefined {
        void this.syncSetup();
        return this.reader.getSingleFieldSync(key, column);
    }

    public getSingleFieldObjSync<C extends keyof T>(key: string, column: C): { key: string; value: T[C]; time: number } | undefined {
        void this.syncSetup();
        return this.reader.getSingleFieldObjSync(key, column);
    }

    public getColumnSync<C extends keyof T>(column: C): { key: string; value: T[C]; time: number }[] | undefined {
        void this.syncSetup();
        return this.reader.getColumnSync(column);
    }

    public isFieldLoadedSync<C extends keyof T>(key: string, column: C): boolean {
        void this.syncSetup();
        return this.reader.isFieldLoadedSync(key, column);
    }

    public isColumnLoadedSync<C extends keyof T>(column: C): boolean {
        void this.syncSetup();
        return this.reader.isColumnLoadedSync(column);
    }

    public async getColumnInfo() {
        const index = await this.ensureIndex();
        return index.reader.columns;
    }

    public async getKeyStats(): Promise<{ rawKeys: number; finalKeys: number; wastedKeys: number; duplication: number; readers: number }> {
        const index = await this.ensureIndex();
        const rawKeys = index.reader.rawKeyCount;
        const finalKeys = index.reader.keys.length;
        return {
            rawKeys,
            finalKeys,
            wastedKeys: rawKeys - finalKeys,
            duplication: finalKeys ? rawKeys / finalKeys : 0,
            readers: index.reader.readerCount,
        };
    }

    public async getReaderInfo() {
        const index = await this.ensureIndex();
        return {
            rowCount: index.reader.rowCount,
            totalBytes: index.reader.totalBytes,
            keyCount: index.reader.keys.length,
            sampleKey: index.reader.keys[0] as string | undefined,
            columns: index.reader.columns,
        };
    }

    public async getFileInfo(): Promise<BulkFileInfoListing> {
        const { bulkFiles, streamFiles } = await this.listFiles();
        const storage = await this.storage();
        const statOf = async (name: string) => {
            try {
                const info = await storage.getInfo(name);
                return { bytes: info?.size ?? 0, lastModified: info?.lastModified ?? 0 };
            } catch { return { bytes: 0, lastModified: 0 }; }
        };
        const bulkInfos = await Promise.all(bulkFiles.map(async f => {
            const stat = await statOf(f.fileName);
            return {
                name: f.fileName,
                type: "bulk" as const,
                bytes: stat.bytes,
                lastModified: stat.lastModified,
                getDetails: async () => {
                    // Bulk: reader has keys + per-row keyTimes + header minTime/maxTime. Cached, so cheap.
                    const reader = await loadFileReader(this.name, storage, f, this.subCaches.bulk);
                    return { keys: reader.keys, minTime: reader.minTime, maxTime: reader.maxTime };
                },
            };
        }));
        const streamInfos = await Promise.all(streamFiles.map(async f => {
            const stat = await statOf(f.fileName);
            return {
                name: f.fileName,
                type: "stream" as const,
                bytes: stat.bytes,
                lastModified: stat.lastModified,
                getDetails: async () => {
                    // Stream: must parse the file to walk every entry — header has no key/time bounds. Cached.
                    const data = await loadStreamEntries(this.name, storage, [f], this.subCaches.stream);
                    const keys = new Set<string>();
                    let minTime = Infinity, maxTime = -Infinity;
                    for (const e of data.entries) {
                        if (e.time < minTime) minTime = e.time;
                        if (e.time > maxTime) maxTime = e.time;
                        if (e.entry.row) keys.add(e.entry.row.key as string);
                        else if (e.entry.deletedKey !== undefined) keys.add(e.entry.deletedKey);
                    }
                    return {
                        keys: [...keys],
                        minTime: minTime === Infinity ? 0 : minTime,
                        maxTime: maxTime === -Infinity ? 0 : maxTime,
                    };
                },
            };
        }));
        const files = [...bulkInfos, ...streamInfos];
        return { files, count: files.length, totalBytes: files.reduce((a, f) => a + f.bytes, 0) };
    }
}

export type BulkFileDetails = { keys: string[]; minTime: number; maxTime: number };
export type BulkFileEntry = {
    name: string;
    type: "bulk" | "stream";
    bytes: number;
    // Filesystem mtime (ms since epoch) — 0 if the storage layer didn't return one.
    lastModified: number;
    // Lazy: pulled from the cached sub-reader for bulk (free if loaded), or from a parse of the stream
    // file (small — tier-0 size-capped, also cached). Call only when you need the per-file detail.
    getDetails: () => Promise<BulkFileDetails>;
};
export type BulkFileInfoListing = { files: BulkFileEntry[]; count: number; totalBytes: number };

