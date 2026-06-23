import { sort } from "socket-function/src/misc";
import { getTimeUnique } from "socket-function/src/bits";
import { ABSENT, BaseBulkDatabaseReader, buildFileBuffer, buildFileBufferRaw, BulkHeaderInfo, EMPTY_BUFFER, KEY_COLUMN, loadBulkDatabase, loadBulkHeader, RawCell, RawRow, TARGET_FILE_BYTES } from "./BulkDatabaseFormat";
import { lazy } from "socket-function/src/caching";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { blue, red } from "socket-function/src/formatting/logColors";
import { blockCache, encodeCompressedBlocks, GetRange } from "./blockCache";
import { STREAM_EXTENSION, StreamEntry, frameRows, frameDeletes, parseStream, streamReaderFromEntries } from "./streamLog";
import { connect as syncConnect, broadcast as syncBroadcast, broadcastSeal as syncBroadcastSeal, isSyncSupported, RemoteWrite } from "./syncClient";
import { tryAcquireMergeLock, releaseMergeLock } from "./mergeLock";
import { isNode } from "typesafecss";
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
// folder rather than sharing bulkDatabases/. Exported so a server-side compactor can find collections.
export const BULK_ROOT_FOLDER = "bulkDatabases2";
const FILE_EXTENSION = ".bulk";
// A single writeBatch that already exceeds these limits skips the tier-0 stream and folds straight
// into a bulk file (streaming thousands of rows one frame at a time would be pointless).
const ROLLOVER_ROWS = 5000;
const ROLLOVER_BYTES = 5 * 1024 * 1024;

// How often the global memory-pressure watchdog samples the heap (the ACTION it may take is throttled
// separately, see bulkDatabase2Timing.memoryFlushThrottleMs).
const MEMORY_WATCHDOG_INTERVAL_MS = 60 * 1000;

// An unreadable (corrupt/torn, not merely missing) file might be a write still in progress, so we
// can't delete it on sight. Once it's been unreadable for longer than this (by its name timestamp),
// no writer is plausibly still working on it, so we delete it. Until then we just warn.
const STALE_DELETE_MS = 24 * 60 * 60 * 1000;

// A read lists the directory then loads each file; if a file vanished (a merge deleted it) we re-list
// and retry, since the merge wrote the replacement first. Bounded so a pathological merge storm can't
// loop forever — after this many tries we load whatever's currently there (the documented inconsistent
// -view bug), which a later reload resolves.
const MAX_READ_ATTEMPTS = 8;

// A read that hits a file a concurrent merge deleted reloads the index and retries; if it keeps hitting
// missing files this many times it gives up and throws (so a genuinely-unreadable file can't loop forever).
const MAX_INDEX_RELOAD_ATTEMPTS = 3;

// The first ("consolidate recent") merge accumulates the newest files up to this many bytes into one
// file (half the target, so it has room to grow before it needs splitting). The key-stratified second
// merge groups keys into runs of this many bytes and only rewrites a group whose fraction of duplicate
// (multi-file) keys exceeds DUP_THRESHOLD — i.e. only when deduping actually buys enough.
const FIRST_MERGE_BYTES = TARGET_FILE_BYTES / 2;
const KEY_GROUP_BYTES = 800 * 1024 * 1024;
const DUP_THRESHOLD = 0.4;

// The browser File System Access API has no real append — every "append" rewrites the whole file — so
// streaming one write at a time is quadratic. We coalesce stream writes and flush on a RAMPING delay:
// the first write after a lull flushes immediately (a single checkbox-then-close is saved at once), and
// as writes keep coming the delay doubles from this step up to writeFlushMaxDelayMs, batching a burst
// into one rewrite. (Node has a real append, so there the default delay is 0 = flush every write.)
const WRITE_FLUSH_FIRST_STEP_MS = 250;

// Time thresholds, mutable so tests can shrink them from hours to milliseconds.
export const bulkDatabase2Timing = {
    // A writer stops appending to its current stream file once it's this old (starts a fresh one). A
    // stream file older than this is therefore safe for a merge to delete: its writer has provably moved
    // on to a new file and will never append to it again.
    streamSealAgeMs: 10 * 60 * 60 * 1000,
    // Per-instance throttle: a write triggers at most one background testMerge scan per this interval.
    mergeCheckIntervalMs: 30 * 60 * 1000,
    // A single testMerge can do several merges (one pass-1 + several pass-2 groups). We wait this long
    // after each one before the next, so a burst of writes doesn't rewrite every index on disk at once —
    // it spreads the work out to keep peak lag low (important in the browser). The merge lock is kept
    // alive across the wait. Set to 0 to disable spacing (tests).
    mergeSpacingMs: 5 * 60 * 1000,
    // The first merge fires when the recent (up to FIRST_MERGE_BYTES) files number more than this...
    firstMergeTriggerFiles: 20,
    // ...or span a wider write-time range than this (data trickling in slowly still gets consolidated).
    firstMergeTriggerRangeMs: 3 * 24 * 60 * 60 * 1000,
    // Tier-0 stream data can't be read per-cell — a read pulls the whole stream — so once the stream
    // exceeds BOTH of these it's folded into bulk (columnar, range-readable) promptly, bypassing the merge
    // throttle. The byte bound matters most over the network, where pulling the whole stream is expensive.
    streamFoldTriggerRows: 100,
    streamFoldTriggerBytes: 64 * 1024 * 1024,
    // Rolling cap on OUR OWN current stream file: once we've appended this much to it, we seal it (stop
    // writing) and fold it into bulk immediately. Without this, many small appends grow a single stream
    // file without bound (the per-batch ROLLOVER only catches one huge batch). We can fold our own file at
    // once — the 10h seal-age rule is only for other writers' files; we know we're done with ours on seal.
    streamFileMaxBytes: 50 * 1024 * 1024,
    // HARD limit: once the stream tier passes this, fold it NOW regardless of age (even un-sealed, recent
    // streams) — a stream this large makes every read pull a huge file, i.e. the collection becomes
    // essentially unreadable. We still only delete a stream whose size didn't change while we read it, so
    // a writer mid-append never loses data (it just gets re-folded next pass).
    streamFoldHardLimitBytes: 768 * 1024 * 1024,
    // Max delay (per collection) before buffered stream writes are flushed to disk; the delay ramps up to
    // this under sustained writing (see WRITE_FLUSH_FIRST_STEP_MS). 0 = flush every write immediately —
    // the default in Node, where append is real and cheap; the browser ramps to 15s to avoid rewriting
    // the whole stream file per write.
    writeFlushMaxDelayMs: isNode() ? 0 : 15 * 1000,
    // We proactively re-list files this often; if the set changed under us (another tab/process merged) we
    // reload the index, so reads pick up the change even without first hitting a missing-file error.
    fileSetPollIntervalMs: 30 * 60 * 1000,
    // Memory-pressure auto-flush (browser only; needs performance.memory). When the JS heap exceeds
    // memoryFlushHeapBytes, at most once per memoryFlushThrottleMs, drop the in-memory observable state of
    // every collection whose loaded data exceeds memoryFlushMinCollectionBytes (they reload lazily). Tuned
    // so it does nothing for a healthy app (heap fine) or small collections.
    memoryFlushHeapBytes: 1500 * 1024 * 1024,
    memoryFlushMinCollectionBytes: 100 * 1024 * 1024,
    memoryFlushThrottleMs: 15 * 60 * 1000,
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

function fmtBytes(n: number): string {
    if (n < 1024) return n + "B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + "GB";
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
    // Whether `signal` currently has any observer watching it. Optional — a backend that can't tell
    // returns undefined (treated as "assume watched"). Lets writes skip per-key notification work for rows
    // nothing is watching (see isWatchedSync).
    isObserved?(signal: string): boolean;
}

// A non-reactive ReactiveDeps: sync reads still return current values, they just never trigger
// re-renders. Use this when you don't need a UI to react to writes. Nothing is ever observed.
export const noopReactiveDeps: ReactiveDeps = {
    observe() { },
    invalidate() { },
    batch(fn) { fn(); },
    isObserved() { return false; },
};

// Provides the FileStorage for a given path (the caller decides where data physically lives, so this
// file needn't know about getFileStorageNested2 / the browser-vs-node storage details).
export type StorageFactory = (path: string) => Promise<FileStorage>;

// Optional per-collection configuration.
export type BulkDatabase2Config = {
    // The MAXIMUM throttle (ms) for reactive change notifications; the actual delay RAMPS UP to it, it is
    // never applied all at once. When set (> 0), the notifications writes/loads emit are batched globally
    // (across all keys) so a high-frequency write source doesn't re-run watchers on every single change: a
    // change after a lull notifies immediately, then under sustained changes the delay doubles up to this
    // ceiling, coalescing the burst into one notification. In-memory/async reads are always current — only
    // the OBSERVABLE notification (the mobx re-render trigger) is delayed and merged.
    maxTriggerThrottleMs?: number;
};

// Trigger-throttle ramp: the first deferred notification waits this long, then the delay doubles on each
// further change up to BulkDatabase2Config.maxTriggerThrottleMs. ~16ms ≈ one animation frame, so an
// isolated burst still notifies within a frame.
const TRIGGER_THROTTLE_FIRST_STEP_MS = 16;

// The load/reset lifecycle shares one signal; every sync read observes it so it re-renders when the
// reader resets or a base column/field finishes loading. The overlay's per-key signal is the key
// itself (a point read observes just its key), plus one overlay-wide signal that whole-column reads
// observe so they recompute on any overlay change. The NUL prefix keeps the two special signals
// from ever colliding with a real data key.
const LOAD_SIGNAL = NULL + "load";
const OVERLAY_SIGNAL = NULL + "overlay";

// Over network storage we skip automatic (background) compaction by default — reading and rewriting whole
// files over the network is expensive. An app that wants it anyway opts in once via
// BulkDatabaseBase.enableNetworkCompaction(). Explicit compact()/tryMergeNow() calls are unaffected.
let networkCompactionEnabled = false;

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

// A resolved merge output row: the raw cells to write (RawRow) plus, for logging only, a count of how
// many of its fields were spliced from each input file (keyed by reader name).
type MergeRow = RawRow & { sources: Map<string, number> };

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
        private config: BulkDatabase2Config = {},
    ) {
        // Best-effort: persist buffered stream writes when the tab is hidden/closing. visibilitychange →
        // hidden fires early enough that the (async) flush usually completes; pagehide is the backstop.
        // No-op outside a browser window (Node).
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
        // Proactively notice another writer's merge (files added/removed) and reload the index, so reads
        // stay correct even without first hitting a missing-file error.
        this.fileSetPollTimer = setInterval(() => void this.pollFileSet(), bulkDatabase2Timing.fileSetPollIntervalMs);
        (this.fileSetPollTimer as { unref?: () => void }).unref?.();
        // Register for the global memory-pressure watchdog (browser only — needs performance.memory).
        BulkDatabaseBase.liveInstances.add(this);
        BulkDatabaseBase.startMemoryWatchdog();
    }

    // ---- memory-pressure watchdog (global, browser-only) ----
    // When the JS heap gets large, the biggest contributors are usually a few collections whose in-memory
    // observable state (loaded reader + base column/field caches) has grown. Rather than cap every
    // collection all the time, we watch the heap and, only when it's actually under pressure, drop the
    // observable state of the large collections (they reload lazily on demand). Throttled hard so it never
    // thrashes a healthy app.
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
        if (typeof performance === "undefined" || usedHeap() === undefined) return; // no heap API (Node / non-Chromium)
        const timer = setInterval(() => {
            const used = usedHeap();
            if (used !== undefined) BulkDatabaseBase.checkMemoryPressure(used);
        }, MEMORY_WATCHDOG_INTERVAL_MS);
        (timer as { unref?: () => void }).unref?.();
    }
    // If the heap is over the limit (and we haven't flushed recently), drop the in-memory observable state
    // of every collection whose loaded data exceeds the size threshold, so it reloads lazily and frees the
    // rest. Exposed (with the heap value injected) so it's callable/testable without the real timer.
    public static checkMemoryPressure(usedHeapBytes: number): void {
        if (usedHeapBytes < bulkDatabase2Timing.memoryFlushHeapBytes) return;
        const now = Date.now();
        if (now - BulkDatabaseBase.lastMemoryFlushMs < bulkDatabase2Timing.memoryFlushThrottleMs) return;
        BulkDatabaseBase.lastMemoryFlushMs = now;
        const flushed: string[] = [];
        for (const db of BulkDatabaseBase.liveInstances) {
            if (db.loadedTotalBytes > bulkDatabase2Timing.memoryFlushMinCollectionBytes) {
                flushed.push(`${db.name} (${fmtBytes(db.loadedTotalBytes)})`);
                db.reloadFromDisk();
            }
        }
        if (flushed.length) console.log(`[bulk2] heap ${fmtBytes(usedHeapBytes)} over ${fmtBytes(bulkDatabase2Timing.memoryFlushHeapBytes)} — flushed observable state of ${flushed.length} large collection(s) to reclaim memory: ${flushed.join(", ")}`);
    }

    // ---- buffered stream writes (per collection) ----
    // The browser rewrites the whole stream file on every append, so we coalesce writes and flush on a
    // ramping delay (see WRITE_FLUSH_FIRST_STEP_MS / writeFlushMaxDelayMs). Each buffered item keeps an
    // `apply` that re-applies its overlay mutation, so resetReader (which clears the overlay) can restore
    // writes that aren't on disk yet. Removed from the buffer only once their append succeeds.
    private pendingAppends: { framed: Buffer; apply: () => void; rows: number }[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | undefined;
    private flushChain: Promise<void> = Promise.resolve();
    private currentFlushDelay = 0;
    private lastWriteTime = 0;

    // Block range cache is global and immutable-file-safe; clear it to simulate a cold page load (e.g.
    // between an untimed prep step and the timed benchmark). The per-instance sub-reader caches need no
    // clearing here — a cold load is a fresh instance, which starts with empty caches.
    public static clearCache() {
        blockCache.clear();
    }

    // Opt in to automatic compaction even when the storage is remote (off by default — see
    // networkCompactionEnabled). Global; affects every collection. Explicit compact()/tryMergeNow() always
    // run regardless of this.
    public static enableNetworkCompaction() {
        networkCompactionEnabled = true;
    }

    public storage = lazy(async () => this.storageFactory(`${BULK_ROOT_FOLDER}/${this.name}`));

    // True when this collection's storage is served over the network (a remote server). Apps can branch on
    // this to adjust behavior for the higher latency (e.g. show a "slower storage" hint, prefetch less).
    public async isRemote(): Promise<boolean> {
        return !!(await this.storage()).isRemote;
    }

    // Whether the tier-0 stream is big enough to fold into bulk now (both bounds): too many rows AND too
    // many bytes to keep reading whole. See bulkDatabase2Timing.streamFoldTrigger*.
    private streamNeedsFold(): boolean {
        return this.streamRowsOnDisk >= bulkDatabase2Timing.streamFoldTriggerRows && this.streamBytesOnDisk > bulkDatabase2Timing.streamFoldTriggerBytes;
    }

    // Automatic (background) compaction is skipped over the network unless the app opted in. Explicit
    // compact()/tryMergeNow() bypass this.
    private async automaticCompactionAllowed(): Promise<boolean> {
        if (networkCompactionEnabled) return true;
        return !(await this.storage()).isRemote;
    }

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

    // Cache of fully-resolved (overlay-patched) column results, keyed by column name. The result only
    // changes when the overlay mutates or the reader resets, so we keep it until then — repeat whole-column
    // reads (common in a UI re-render) are then free, however large the column. Each cached array is frozen
    // SHALLOWLY: Object.freeze locks the array itself (callers can't mutate a shared result) but never the
    // element objects or their values, so typed-array column values keep their fast representation.
    private columnCache = new Map<string, { key: string; value: unknown; time: number }[]>();
    // Live keys of the currently-loaded reader (disk only, no overlay), so a write can tell a partial
    // update of an existing key (only the written columns change) from adding/removing a key (which appears
    // in / disappears from EVERY column). Set on reader build, cleared on reset.
    private readerKeys: Set<string> | undefined;

    // ---- the on-disk index ----
    // The "index" is the loaded reader (file headers + key columns joined into a resolved view) plus the
    // set of files it was built from. A concurrent merge in another tab/process rewrites files out from
    // under us; we notice either when a read hits a deleted file (readWithReload) or via the periodic poll
    // (pollFileSet), and reload the index — cheap, since a build only reads headers + key columns.
    private loadedFileSet: Set<string> | undefined; // file names the current reader was built from
    // Total (uncompressed) size of the data the current reader spans, as a proxy for this collection's
    // in-memory footprint — used by the memory-pressure watchdog. 0 when no reader is loaded.
    private loadedTotalBytes = 0;
    // Bumped every time the index is cleared/reloaded. A failed read captures it before reading and only
    // triggers a reload if it's unchanged afterward — so N concurrent failures coalesce onto ONE rebuild
    // (the rest see the bumped epoch, skip their own reload, and just await the in-flight one).
    private readerEpoch = 0;
    private fileSetPollTimer: ReturnType<typeof setInterval> | undefined;

    // Per-file decoded sub-reader caches (keyed by fileName), so reloading the index re-reads only the
    // files that actually changed — the stitch (join) still runs, but unchanged files skip re-decoding.
    // Per-INSTANCE (not global), because a cached reader's getRange is bound to THIS instance's storage
    // backend; in production a collection has one backend, and a "fresh client" is a new process with empty
    // caches anyway. Bulk files are immutable, so a name maps to fixed content (cache until the file is
    // gone). Stream files are append-only, so size is the version: reuse on a size match, else parse only
    // the appended suffix. Pruned per build for files a merge removed (pruneFileCaches); survive the reader
    // reset (that's the point — a reload reuses them).
    private bulkReaderCache = new Map<string, BaseBulkDatabaseReader>();
    private streamReaderCache = new Map<string, { readSize: number; parsedPos: number; entries: StreamEntry[] }>();
    // Bumped on every overlay mutation / reader reset. An async column build captures it before its awaits
    // and only caches its result if it hasn't changed since — so a write or reset mid-build (which clears
    // the cache and may swap the reader) can never leave a stale entry behind.
    private dataGen = 0;

    // ---- trigger throttle (see BulkDatabase2Config.maxTriggerThrottleMs) ----
    // Signals whose notification is deferred, the pending flush timer, and the ramping delay. Data state is
    // already updated synchronously; only these observable notifications are batched/delayed.
    private pendingSignals = new Set<string>();
    private triggerTimer: ReturnType<typeof setTimeout> | undefined;
    private currentTriggerDelay = 0;
    private lastTriggerTime = 0;

    // Approximate size of the tier-0 stream data on disk: set accurately from the last reader build, then
    // kept current as each flush appends more. Drives the stream-fold trigger (see streamNeedsFold);
    // reset on resetReader, since after a merge/reset the next reader build re-measures it.
    private streamRowsOnDisk = 0;
    private streamBytesOnDisk = 0;

    // This instance's tier-0 stream file. Each instance (≈ each thread/tab) streams to its own file
    // so concurrent writers never touch the same file.
    private streamFileName: string | undefined;
    // Rolling size of the current stream file, so we can seal+fold it once it passes STREAM_FILE_MAX_BYTES
    // (reset whenever the file rotates). currentStreamFileName tracks which file the count belongs to.
    private currentStreamFileName: string | undefined;
    private currentStreamFileBytes = 0;
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

    // Invalidate after an overlay change. `columns` is the set of columns whose resolved result actually
    // changed — only those cached columns are dropped — or "all" when the key set itself changed (a key
    // added or removed appears in / disappears from every column).
    private invalidateOverlay(key: string, columns: Iterable<string> | "all") {
        this.dataGen++;
        if (columns === "all") this.columnCache.clear();
        else for (const c of columns) this.columnCache.delete(c);
        // The per-key signal only re-runs getSingleFieldObjSync watchers of THIS key; skip it when nothing
        // is watching the row (a new watcher reads the current overlay anyway). The overlay-wide signal +
        // column-cache drop above still cover whole-column watchers and read correctness.
        if (this.deps.isObserved?.(key) ?? true) this.invalidateSignal(key);
        this.invalidateSignal(OVERLAY_SIGNAL);
    }

    // Whether a row (key) is currently being watched — i.e. some reactive observer is subscribed to it via
    // getSingleFieldObjSync / getSingleFieldSync. Useful for skipping per-row work when nothing's watching.
    // Returns true if the backend can't tell (conservative).
    public isKeyWatched(key: string): boolean {
        return this.deps.isObserved?.(key) ?? true;
    }

    // Whether `key` is currently a live key in the resolved view (overlay wins over disk). A write to a key
    // that's already live only changes the columns it sets; a write to an absent key (or one currently
    // deleted in the overlay) makes it appear in every column, so every column's cache must drop.
    private isLiveNow(key: string): boolean {
        const e = this.overlay.get(key);
        if (e) return e.value !== DELETED;
        return this.readerKeys?.has(key) ?? false;
    }

    // Notify observers of `signal`. With maxTriggerThrottleMs set, notifications are batched and delayed on
    // a ramping schedule so a high-frequency source can't re-run watchers on every change: a change after a
    // lull notifies on the next tick (no real delay, but all of one change's signals batch together);
    // under sustained changes the delay doubles up to the max, coalescing the burst into one notification.
    // Only the OBSERVABLE notification is delayed — the underlying data was already updated, so a read in
    // the meantime still sees current values.
    private invalidateSignal(signal: string) {
        const maxMs = this.config.maxTriggerThrottleMs ?? 0;
        if (maxMs <= 0) { this.deps.invalidate(signal); return; }
        this.pendingSignals.add(signal);
        const now = Date.now();
        const lull = now - this.lastTriggerTime > maxMs;
        this.lastTriggerTime = now;
        if (this.triggerTimer !== undefined) return; // a flush is already scheduled; it will pick this up
        // Lull resets the ramp (notify next tick); an active burst ramps the delay toward the max.
        this.currentTriggerDelay = lull ? 0 : Math.min(maxMs, Math.max(TRIGGER_THROTTLE_FIRST_STEP_MS, this.currentTriggerDelay * 2));
        this.triggerTimer = setTimeout(() => { this.triggerTimer = undefined; this.flushSignals(); }, this.currentTriggerDelay);
        (this.triggerTimer as { unref?: () => void }).unref?.();
    }

    private flushSignals() {
        if (this.pendingSignals.size === 0) return;
        const signals = [...this.pendingSignals];
        this.pendingSignals.clear();
        this.deps.batch(() => { for (const s of signals) this.deps.invalidate(s); });
    }

    // Merges a (possibly partial) row onto the key's current overlay value, so a partial write/update
    // only changes the columns it includes — the rest fall through to disk on read. A prior delete is
    // reset (the key is being re-created).
    private setOverlayRow(key: string, row: Record<string, unknown>, time: number) {
        // Decide BEFORE mutating: if the key is already live, only the columns this write sets change;
        // otherwise it's a new/re-created key that joins every column.
        const wasLive = this.isLiveNow(key);
        const existing = this.overlay.get(key);
        const value = existing && existing.value !== DELETED ? { ...existing.value, ...row } : { ...row };
        this.overlay.set(key, { time, value });
        this.invalidateOverlay(key, wasLive ? Object.keys(row) : "all");
    }

    private setOverlayDeleted(key: string, time: number) {
        // Deleting a live key removes it from every column; deleting an absent key changes no column.
        const columns = this.isLiveNow(key) ? "all" : [];
        this.overlay.set(key, { time, value: DELETED });
        this.invalidateOverlay(key, columns);
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

        // Accurate stream size as of this load; subsequent flushes keep it current (see doFlush).
        this.streamRowsOnDisk = streamData.entries.length;
        this.streamBytesOnDisk = streamData.totalBytes;

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
        // Live keys of this reader, so per-column cache invalidation can tell an update of an existing key
        // (only its set columns change) from a key add/remove (which touches every column).
        this.readerKeys = new Set(joined.keys);
        // The files this index was built from, so the poll can detect a concurrent merge changing the set.
        this.loadedFileSet = new Set([...bulkFiles.map(f => f.fileName), ...streamFiles.map(f => f.fileName)]);
        this.loadedTotalBytes = joined.totalBytes; // footprint proxy for the memory-pressure watchdog

        // Evict cached sub-readers for files a merge removed, so the caches track the live file set.
        this.pruneFileCaches(bulkFiles, streamFiles);

        let time = Date.now() - start;
        if (time > 50) {
            // Bytes we actually had to read: the full stream files + each bulk file's key column (the
            // part we read on load to get its keys).
            let bytesRead = streamData.totalBytes;
            for (const r of bulkReaders) bytesRead += r.columns.find(c => c.column === KEY_COLUMN)?.byteSize ?? 0;
            console.log(`${blue(this.name)} loaded in ${red(formatTime(time))} (${blue(formatNumber(joined.rowCount))} rows, ${bulkFiles.length} bulk + ${streamFiles.length} stream files, read ${blue(formatNumber(bytesRead))}B)`);
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

    // Drop the loaded index (reader) and everything derived from it, so the next read rebuilds via
    // buildReader. Does NOT touch the overlay — callers decide what to do with pending writes.
    private clearReaderState() {
        this.reader.reset();
        // Preserve the last-known sync base values so a reload/compact serves them (not empty) while the
        // fresh ones reload — observers transition old → new, never flashing through nothing.
        for (const [k, v] of this.baseColumns) this.staleBaseColumns.set(k, v);
        for (const [k, v] of this.baseFields) this.staleBaseFields.set(k, v);
        this.baseColumns.clear();
        this.baseColumnsLoading.clear();
        this.baseFields.clear();
        this.baseFieldsLoading.clear();
        this.columnCache.clear();
        this.readerKeys = undefined;     // the next build repopulates it
        this.loadedFileSet = undefined;  // ditto
        this.loadedTotalBytes = 0;       // nothing loaded ⇒ no footprint for the memory watchdog
        // The next build re-measures the stream; clear the estimate so a just-folded stream doesn't keep
        // looking "heavy" and re-trigger a fold before then.
        this.streamRowsOnDisk = 0;
        this.streamBytesOnDisk = 0;
        this.dataGen++;
        this.readerEpoch++; // so an in-flight read knows the index changed under it (see readWithReload)
    }

    // Reset the loaded reader AND drop the overlay. Used only on structural changes WE made (large
    // direct-bulk write, rollover, compact) after the data has been persisted. Writes still buffered (not
    // yet on disk) are re-applied so the reset doesn't drop them from reads — they aren't in the reloaded
    // reader until their append lands.
    private resetReader() {
        this.deps.batch(() => {
            this.clearReaderState();
            this.overlay.clear();
            for (const p of this.pendingAppends) p.apply();
            this.invalidateSignal(LOAD_SIGNAL);
            this.invalidateSignal(OVERLAY_SIGNAL);
        });
    }

    // Reload just the on-disk index after the file set changed UNDER us (a concurrent merge). Keeps the
    // overlay: our pending writes are in-memory and independent of which files exist on disk.
    private reloadReader() {
        this.deps.batch(() => {
            this.clearReaderState();
            this.invalidateSignal(LOAD_SIGNAL);
            this.invalidateSignal(OVERLAY_SIGNAL);
        });
    }

    // Drop ALL of this collection's in-memory loaded caches (the resolved reader, the sync base column /
    // field caches and their stale fallbacks, the per-file decoded readers) and re-trigger every watcher,
    // so they re-request and reload from disk. Unlike the automatic reloads, this is a genuine full clear
    // (no stale-fallback served — watchers go through a real loading state). Pending un-flushed writes (the
    // overlay) are KEPT, so nothing not-yet-on-disk is lost. Per-collection (this instance only).
    public reloadFromDisk(): void {
        this.deps.batch(() => {
            this.clearReaderState();       // drops reader + base caches (→ stale) + column cache; bumps gens
            this.staleBaseColumns.clear(); // and the stale fallbacks — a genuine full clear, not a swap
            this.staleBaseFields.clear();
            this.bulkReaderCache.clear();  // force re-decode from disk
            this.streamReaderCache.clear();
            this.invalidateSignal(LOAD_SIGNAL);
            this.invalidateSignal(OVERLAY_SIGNAL);
        });
    }

    // Run a read against the loaded index; if a file vanished mid-read (a concurrent merge deleted it),
    // reload the index and retry — looping until it succeeds or we've tried MAX_INDEX_RELOAD_ATTEMPTS times.
    // Reloads coalesce: a failing read only resets the index if nobody has reset it since the read grabbed
    // its reader (readerEpoch unchanged). So N concurrent failures cause ONE rebuild — the first resets, the
    // rest see the bumped epoch and just await the in-flight rebuild that lazy() shares — and a good rebuild
    // is never thrown away by a straggler.
    private async readWithReload<R>(fn: (reader: ResolvedReader) => Promise<R>): Promise<R> {
        for (let attempt = 0; ; attempt++) {
            const reader = await this.reader();
            const epoch = this.readerEpoch; // epoch of the reader we're about to use
            try {
                return await fn(reader);
            } catch (e) {
                if (!(e instanceof MissingFileError) || attempt >= MAX_INDEX_RELOAD_ATTEMPTS) throw e;
                if (this.readerEpoch === epoch) this.reloadReader();
                // else: another reader already reloaded the index — loop and use its rebuild.
            }
        }
    }

    // Proactively reload the index if the on-disk file set changed under us (a merge in another tab/
    // process), so reads pick up the new files even without first hitting a read error. Cheap — just lists
    // the directory. Runs on a timer (fileSetPollIntervalMs).
    private async pollFileSet(): Promise<void> {
        if (!this.loadedFileSet) return; // reader not built yet → nothing loaded to compare against
        let current: Set<string>;
        try {
            const { bulkFiles, streamFiles } = await this.listFiles();
            current = new Set([...bulkFiles.map(f => f.fileName), ...streamFiles.map(f => f.fileName)]);
        } catch { return; }
        const prev = this.loadedFileSet;
        if (!prev) return; // reloaded during the await
        const changed = current.size !== prev.size || [...current].some(n => !prev.has(n));
        if (changed) this.reloadReader();
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

        // Reflect in the overlay + broadcast to other tabs IMMEDIATELY (in-memory + cross-tab are always
        // current), but buffer the disk append and flush it on a ramping schedule.
        const apply = () => { for (const { time, row } of stamped) this.setOverlayRow(row.key as string, row, time); };
        this.deps.batch(apply);
        for (const { time, row } of stamped) syncBroadcast(this.name, { key: row.key as string, time, value: row });
        await this.streamAppend(framed, apply, stamped.length);
        void this.maybeMerge();
    }

    public async delete(key: string): Promise<void> {
        return this.deleteBatch([key]);
    }

    public async deleteBatch(keys: string[]): Promise<void> {
        if (!keys.length) return;
        void this.syncSetup();
        const stamped = keys.map(key => ({ time: getTimeUnique(), key }));
        const apply = () => { for (const { time, key } of stamped) this.setOverlayDeleted(key, time); };
        this.deps.batch(apply);
        for (const { time, key } of stamped) syncBroadcast(this.name, { key, time, deleted: true });
        await this.streamAppend(frameDeletes(stamped), apply, stamped.length);
        void this.maybeMerge();
    }

    // Buffers framed stream bytes and flushes on a ramping per-collection schedule (see the field block).
    // `apply` re-applies this write's overlay mutation if resetReader clears the overlay before it's on
    // disk. Awaits durability only on an immediate (idle/Node) flush, so a single action — then close — is
    // saved at once; a burst returns fast and is flushed in the background.
    private async streamAppend(framed: Buffer, apply: () => void, rows: number): Promise<void> {
        this.pendingAppends.push({ framed, apply, rows });
        const max = bulkDatabase2Timing.writeFlushMaxDelayMs;
        const now = Date.now();
        // Immediate when batching is off (Node / real append), or for the first write after a lull.
        if (max <= 0 || this.currentFlushDelay <= 0 || now - this.lastWriteTime > max) {
            this.lastWriteTime = now;
            this.currentFlushDelay = max > 0 ? Math.min(max, WRITE_FLUSH_FIRST_STEP_MS) : 0;
            await this.flushPending();
            return;
        }
        // Active burst: coalesce into one scheduled flush and ramp the delay toward max.
        this.lastWriteTime = now;
        if (this.flushTimer === undefined) {
            this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.flushPending(); }, this.currentFlushDelay);
        }
        this.currentFlushDelay = Math.min(max, this.currentFlushDelay * 2);
    }

    // Flushes all buffered stream writes to disk as one append. Serialized (so two flushes never write the
    // same file concurrently) and best-effort: a failed append keeps the data buffered for the next try.
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
        if (fileName !== this.currentStreamFileName) { // rotated (age-seal / first write) → reset the count
            this.currentStreamFileName = fileName;
            this.currentStreamFileBytes = 0;
        }
        // Throws on failure -> we don't splice, so the data stays buffered and a later flush retries it.
        await storage.append(fileName, combined);
        // New writes added during the await are after `batch`, so removing the front is exactly the flushed set.
        this.pendingAppends.splice(0, batch.length);
        // Keep the stream-size estimate current so the fold trigger sees write-accumulation between reads.
        this.streamBytesOnDisk += combined.length;
        for (const p of batch) this.streamRowsOnDisk += p.rows;
        this.currentStreamFileBytes += combined.length;
        // Cap our own stream file: once it's grown past the limit, seal it (next write starts a fresh file)
        // and fold this now-complete file into bulk in the background. New writes go to the new file, so the
        // sealed one is stable and safe to fold+delete immediately — no 10h wait for our own files.
        if (this.currentStreamFileBytes >= bulkDatabase2Timing.streamFileMaxBytes) {
            this.streamFileName = undefined;
            this.currentStreamFileName = undefined;
            this.currentStreamFileBytes = 0;
            void this.foldOwnStream(fileName);
        }
    }

    // Fold one of OUR OWN sealed stream files into bulk and delete it. Safe to delete immediately (force):
    // we've stopped appending to it (a new file is current now), and canDeleteStream still only deletes it
    // if its size is unchanged since we read it, so an in-flight flush can never lose data.
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
        for (const built of buildFileBuffer(rows, times)) {
            const name = newFileName(timestamp);
            await storage.set(name, encodeCompressedBlocks(built.buffer));
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
        // Per-file parse, reusing streamCache when the file hasn't grown. Stream files are append-only, so
        // size is the version: same size ⇒ same parsed entries; a larger size ⇒ parse only the appended
        // suffix and tack it on. We read a bounded prefix [0, size) — a foreign writer may be appending, and
        // storage.get() errors past the stat'd size; parseStream stops at the last complete frame, so a
        // later read picks up the rest. A file removed out from under us (a merge) sets `missing`.
        const perFile = await Promise.all(streamFiles.map(async (f): Promise<{ fileName: string; size: number; entries: StreamEntry[] } | undefined> => {
            try {
                const info = await storage.getInfo(f.fileName);
                if (!info) { missing = true; return undefined; }
                const size = info.size;
                sizes.set(f.fileName, size);
                const cached = this.streamReaderCache.get(f.fileName);
                if (cached && cached.readSize === size) return { fileName: f.fileName, size, entries: cached.entries };
                if (size === 0) { this.streamReaderCache.set(f.fileName, { readSize: 0, parsedPos: 0, entries: [] }); return { fileName: f.fileName, size: 0, entries: [] }; }
                if (cached && size > cached.readSize) {
                    // Grew: parse only the appended bytes from where we last stopped (a frame boundary).
                    const suffix = await storage.getRange(f.fileName, { start: cached.parsedPos, end: size });
                    if (!suffix) { missing = true; return undefined; }
                    const parsed = parseStream(suffix);
                    if (parsed.badBytes > 0) console.warn(`${this.name} stream file ${f.fileName} had ${parsed.badBytes} trailing bad/incomplete bytes (stopped reading there)`);
                    const entries = parsed.entries.length ? cached.entries.concat(parsed.entries) : cached.entries;
                    const parsedPos = cached.parsedPos + (suffix.length - parsed.badBytes);
                    this.streamReaderCache.set(f.fileName, { readSize: size, parsedPos, entries });
                    return { fileName: f.fileName, size, entries };
                }
                // Cold (or the rare shrink/rewrite): full read from the start.
                const buffer = await storage.getRange(f.fileName, { start: 0, end: size });
                if (!buffer) { missing = true; return undefined; }
                const parsed = parseStream(buffer);
                if (parsed.badBytes > 0) console.warn(`${this.name} stream file ${f.fileName} had ${parsed.badBytes} trailing bad/incomplete bytes (stopped reading there)`);
                this.streamReaderCache.set(f.fileName, { readSize: size, parsedPos: size - parsed.badBytes, entries: parsed.entries });
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

    // Global mutation order across per-thread files: by unique timestamp, ties broken by file name.
    private orderStreamEntries(entries: { time: number; fileName: string; entry: StreamEntry }[]): StreamEntry[] {
        entries.sort((a, b) => {
            if (a.time !== b.time) return a.time - b.time;
            return a.fileName < b.fileName && -1 || a.fileName > b.fileName && 1 || 0;
        });
        return entries.map(e => e.entry);
    }

    // Throttled, fire-and-forget after writes: run a background merge check at most once per interval — but
    // a tier-0 stream that's grown too big folds promptly, bypassing the throttle. Skipped entirely over
    // the network unless the app opted in (see automaticCompactionAllowed).
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
            await this.flushPending(); // get buffered writes on disk so they're folded in
            syncBroadcastSeal(this.name);
            this.streamFileName = undefined;
            const { bulkFiles, streamFiles } = await this.listFiles();
            // compact() merges every file on disk, so nothing older survives outside it — tombstones for
            // fully-deleted keys can be dropped rather than carried into a fresh carry stream.
            if (bulkFiles.length + streamFiles.length >= 1) await this.mergeFileSet(bulkFiles, streamFiles, true);
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
        // timeLo <= 0 reaches the start of time: every older file overlaps [timeLo, timeHi] and is in the
        // merge, so no older set survives outside it and surviving tombstones can be dropped.
        await this.mergeFileSet(selBulk, selStream, timeLo <= 0);
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
        // Bulk files are immutable, so a decoded sub-reader (keys + keyTimes + columns) is valid until the
        // file is gone — reuse it so an index reload doesn't re-decode unchanged files. (We skip the getInfo
        // existence check on a hit; if the file was merged away mid-build the deferred read fails and
        // readWithReload recovers — and buildReader won't ask for files that aren't currently listed.)
        const cached = this.bulkReaderCache.get(fileName);
        if (cached) return cached;
        const raw = await this.makeRawGetRange(fileName);
        const fileId = nullJoin(this.name, fileName);
        // Stored as compressed blocks; replace getRange with a block-cached, decompressing version (same
        // interface) and read the logical (uncompressed) size from its index. open() validates the file
        // size against the index and throws if it's truncated/corrupt.
        const opened = await blockCache.open(fileId, raw.size, raw.rawGetRange);
        const reader = await loadBulkDatabase({ totalBytes: opened.uncompressedSize, getRange: opened.getRange });
        this.bulkReaderCache.set(fileName, reader);
        return reader;
    }

    // Drop cached sub-readers for files that no longer exist (a merge replaced them), so the caches track
    // the live file set instead of growing with churn. Called after each successful build.
    private pruneFileCaches(bulkFiles: BulkFileInfo[], streamFiles: StreamFileInfo[]) {
        const liveBulk = new Set(bulkFiles.map(f => f.fileName));
        const liveStream = new Set(streamFiles.map(f => f.fileName));
        for (const name of this.bulkReaderCache.keys()) if (!liveBulk.has(name)) this.bulkReaderCache.delete(name);
        for (const name of this.streamReaderCache.keys()) if (!liveStream.has(name)) this.streamReaderCache.delete(name);
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
    // Resolves a set of readers into the merged output, splicing raw on-disk cell bytes rather than
    // decoding every value to a JS object and re-encoding. For each live key we pick, per column, the cell
    // from the reader with the newest write-time for that key that actually set the column (ABSENT cells
    // are absent from getRawColumn, so they fall through). The winning cell's bytes are copied straight
    // through. `readerNames[i]` labels readers[i] so the merge can log where each output field came from.
    private async resolveReadersRaw(readers: BaseBulkDatabaseReader[], readerNames: string[]): Promise<{ rows: MergeRow[]; deletes: Map<string, number> }> {
        const loaded = await Promise.all(readers.map(async (reader, idx) => {
            const cols = new Map<string, Map<string, RawCell>>();
            for (const col of reader.columns) {
                if (col.column === KEY_COLUMN) continue;
                cols.set(col.column, await reader.getRawColumn(col.column));
            }
            return { name: readerNames[idx], keyTimes: reader.keyTimes, deleteTimes: reader.deleteTimes, cols };
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

        const rows: MergeRow[] = [];
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
            const cells = new Map<string, RawCell>();
            const sources = new Map<string, number>();
            for (const col of allCols) {
                let bestTime = -Infinity;
                let bestCell: RawCell | undefined;
                let bestName = "";
                for (const l of loaded) {
                    const cell = l.cols.get(col)?.get(key);
                    if (!cell) continue; // ABSENT in this reader → fall through
                    const t = l.keyTimes.get(key) ?? -Infinity;
                    if (t > bestTime) { bestTime = t; bestCell = cell; bestName = l.name; }
                }
                if (bestCell) { cells.set(col, bestCell); sources.set(bestName, (sources.get(bestName) ?? 0) + 1); }
            }
            rows.push({ key, time: setT === -Infinity ? 0 : setT, cells, sources });
        }
        return { rows, deletes };
    }

    // The one merge primitive. Reads the given bulk + stream files (skipping any that vanished or won't
    // parse — their data lives elsewhere), resolves them by write-time, writes the result back as fresh
    // key-sorted ~256MB bulk file(s) plus a carry stream for surviving tombstones, THEN deletes the
    // inputs it consumed. Output is always written before any delete, so a crash leaves duplicates (next
    // merge removes them), never a gap. A bulk file is deleted only if we actually read it; a stream file
    // only if it's aged out (its writer has switched files) or — when cross-tab sync sealed it — its size
    // didn't change while we read it. Returns whether it produced anything.
    // `includesOldest` means this merge consumes every file at or before its time range — there is no
    // file before it on disk. A surviving tombstone only exists to suppress an OLDER set in some file
    // outside the merge; if nothing older exists, that older set can't exist either, so the tombstone has
    // nothing left to suppress and we drop it instead of carrying it forward. (A full compact and a
    // merge that reaches time 0 are the cases where this holds.)
    private async mergeFileSet(bulkFiles: BulkFileInfo[], streamFiles: StreamFileInfo[], includesOldest = false, forceDeleteStreams = false): Promise<boolean> {
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
        // Labels aligned with `readers`, so the merge can log which input each output field was spliced
        // from. bulkReaders[i] corresponds to consumedBulk[i] (pushed together above).
        const readerNames = streamReader ? ["(streams)", ...consumedBulk.map(f => f.fileName)] : consumedBulk.map(f => f.fileName);
        if (!readers.length) return false;

        // Log the inputs of a REAL merge (files + on-disk sizes). Only here, never for the planning checks
        // in testMerge/findDuplicateGroups, so the log marks actual rewrites and their before/after I/O.
        const inputs = [
            ...await Promise.all(consumedBulk.map(async f => ({ name: f.fileName, size: (await storage.getInfo(f.fileName).catch(() => undefined))?.size ?? 0 }))),
            ...streamFiles.map(f => ({ name: f.fileName, size: streamData.sizes.get(f.fileName) ?? 0 })),
        ];
        const inTotal = inputs.reduce((a, f) => a + f.size, 0);
        const mergeStartMs = Date.now();
        console.log(`${blue(this.name)} merge: reading ${inputs.length} files (${fmtBytes(inTotal)}) at ${new Date(mergeStartMs).toISOString()}`);
        for (const f of inputs) console.log(`    in  ${f.name}  ${fmtBytes(f.size)}`);

        const { rows, deletes } = await this.resolveReadersRaw(readers, readerNames);
        // We've read everything we need from the input bulk files (and they're about to be deleted), so drop
        // their decompressed blocks now instead of letting them sit in memory through the output + compress
        // phase. The output below comes entirely from this single resolved set — never a per-output re-read.
        for (const f of consumedBulk) blockCache.evict(nullJoin(this.name, f.fileName));
        console.log(`${blue(this.name)} merge: resolved ${formatNumber(rows.length)} live rows + ${formatNumber(deletes.size)} tombstones from ${readers.length} readers; writing now`);

        // Write all outputs BEFORE deleting any input, so a throw mid-write just leaves duplicates.
        const newNames: string[] = [];
        if (rows.length) {
            const built = buildFileBufferRaw(rows);
            // Walk the rows in key order alongside the (key-contiguous, ascending) output files so each
            // file can log which input files its fields were spliced from — i.e. "where they came from".
            const sorted = rows.slice().sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
            let ri = 0;
            const split = built.length > 1;
            if (split) console.log(`${blue(this.name)} merge: output split into ${built.length} files (> ${fmtBytes(TARGET_FILE_BYTES)} each)`);
            for (let i = 0; i < built.length; i++) {
                const part = built[i];
                const srcCounts = new Map<string, number>();
                while (ri < sorted.length && sorted[ri].key <= part.maxKey) {
                    for (const [src, n] of sorted[ri].sources) srcCounts.set(src, (srcCounts.get(src) ?? 0) + n);
                    ri++;
                }
                const srcText = [...srcCounts.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}:${formatNumber(n)}`).join(", ") || "—";
                const name = newFileName(timestamp);
                const subStart = Date.now();
                console.log(`    [${i + 1}/${built.length}] writing ${formatNumber(part.rowCount)} rows [${part.minKey} .. ${part.maxKey}] from {${srcText}} → ${name} at ${new Date(subStart).toISOString()}`);
                await storage.set(name, encodeCompressedBlocks(part.buffer));
                newNames.push(name);
                console.log(`    [${i + 1}/${built.length}] wrote ${name} (${fmtBytes((await storage.getInfo(name).catch(() => undefined))?.size ?? 0)}) in ${formatTime(Date.now() - subStart)}`);
            }
        }
        // Carry surviving tombstones forward only if older files exist outside this merge that they still
        // need to suppress; when this merge includes the oldest data there's nothing older to suppress.
        const carriedDeletes = includesOldest ? 0 : deletes.size;
        const outNames = [...newNames];
        if (carriedDeletes) {
            const carryName = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${STREAM_EXTENSION}`;
            await storage.set(carryName, frameDeletes([...deletes].map(([key, time]) => ({ time, key }))));
            outNames.push(carryName);
        }

        // Log the result (files + on-disk sizes), so the before→after of the merge is visible.
        const outputs = await Promise.all(outNames.map(async n => ({ name: n, size: (await storage.getInfo(n).catch(() => undefined))?.size ?? 0 })));
        const outTotal = outputs.reduce((a, f) => a + f.size, 0);
        console.log(`${blue(this.name)} merge: wrote ${outputs.length} files (${fmtBytes(outTotal)}, from ${fmtBytes(inTotal)})${carriedDeletes ? `, ${carriedDeletes} tombstones carried` : ""} at ${new Date().toISOString()} (took ${formatTime(Date.now() - mergeStartMs)})`);
        for (const f of outputs) console.log(`    out ${f.name}  ${fmtBytes(f.size)}`);

        const remove = async (name: string) => { try { await storage.remove(name); } catch { /* already gone */ } };
        for (const f of consumedBulk) await remove(f.fileName);
        for (const f of streamFiles) {
            if (await this.canDeleteStream(f, now, streamData.sizes, forceDeleteStreams)) await remove(f.fileName);
        }

        this.resetReader();
        return newNames.length > 0 || carriedDeletes > 0;
    }

    // A stream file is safe to delete iff no writer will ever append to it again: it's aged past the seal
    // age (its writer has provably started a fresh file), OR cross-tab sync is active (so the seal we
    // broadcast reached peers) and its size hasn't changed since we read it (nothing was appended during
    // the merge). When neither holds we leave it: its data is now duplicated into bulk (resolved by time)
    // and a later merge deletes it once aged. (Recreate-on-append means even a wrong delete wouldn't lose
    // data, but the aged check also rules out the rare sparse-offset append race.)
    private async canDeleteStream(f: StreamFileInfo, now: number, sizes: Map<string, number>, force = false): Promise<boolean> {
        if (now - f.timestamp >= bulkDatabase2Timing.streamSealAgeMs) return true;
        // Without cross-tab sync we normally can't tell a writer is done before the seal age — UNLESS the
        // caller forces it (the hard stream limit). Even then we only delete a stream whose size didn't
        // change while we read it, so a writer mid-append never loses data (it's re-folded next pass).
        if (!isSyncSupported() && !force) return false;
        const readSize = sizes.get(f.fileName);
        if (readSize === undefined) return false;
        let info;
        try { info = await (await this.storage()).getInfo(f.fileName); } catch { return false; }
        return !!info && info.size === readSize;
    }

    // Waits mergeSpacingMs between merges so a burst of work doesn't rewrite every index at once (keeps
    // peak lag low for the browser). Heartbeats the merge lock through the wait; returns false if another
    // tab took the lock over, so the caller stops doing further merges.
    private async mergeSpacingDelay(): Promise<boolean> {
        const total = bulkDatabase2Timing.mergeSpacingMs;
        if (total <= 0) return tryAcquireMergeLock(this.name, writerId);
        const step = 15 * 1000; // re-stamp the lock well within its TTL
        let waited = 0;
        while (waited < total) {
            await new Promise<void>(r => setTimeout(r, Math.min(step, total - waited)));
            waited += step;
            if (!tryAcquireMergeLock(this.name, writerId)) return false; // another tab took over
        }
        return true;
    }

    // The merge policy. Two passes, with a mergeSpacingMs pause after every merge (so a write burst
    // doesn't rewrite all indexes at once):
    //  1) Consolidate recent fragmentation (one merge): take the newest files up to ~FIRST_MERGE_BYTES
    //     and, if they number more than firstMergeTriggerFiles or span more than firstMergeTriggerRangeMs,
    //     merge them into one file. Seals first so recent stream data is complete; in Node (no cross-tab
    //     seal) only aged streams are folded, so we never re-fold the same un-deletable stream forever.
    //  2) Key-stratify (possibly several merges): sort all keys, walk them in ~KEY_GROUP_BYTES groups, and
    //     rewrite EVERY group whose fraction of duplicate (multi-file) keys exceeds DUP_THRESHOLD —
    //     highest-duplication first — merging the bulk files overlapping that key range. Groups have
    //     disjoint key ranges, so one group's merge doesn't change another's duplication; we re-select
    //     each group's files at merge time (the file set shifts as we go). Over time this sorts the data
    //     into key-disjoint files. Returns whether any merge happened.
    private async testMerge(): Promise<boolean> {
        let merged = false;
        await this.flushPending(); // get buffered writes on disk so this pass can fold/consider them
        // Run a merge, pausing first if we've already merged this pass (so the pause is BETWEEN merges,
        // never before the first or after the last). Returns false if we lost the lock — stop entirely.
        const runMerge = async (bulk: BulkFileInfo[], stream: StreamFileInfo[]): Promise<boolean> => {
            if (merged && !await this.mergeSpacingDelay()) return false;
            if (await this.mergeFileSet(bulk, stream)) merged = true;
            return true;
        };

        // ── Hard stream limit: once the tier-0 stream has grown past the hard cap, fold ALL of it into bulk
        //    NOW regardless of age — a stream this big makes every read pull a huge file, i.e. the collection
        //    is essentially unreadable. Force-delete the folded streams (canDeleteStream still only deletes
        //    size-stable ones, so an active writer never loses data; it's just re-folded next pass). ──
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
            // Fold when there's enough fragmentation to consolidate, OR when the foldable stream data here
            // has grown past the byte threshold (stream data can't be read per-cell, so a big stream is
            // costly to pull whole). The stream size is derived from THIS fresh listing — not a cached
            // counter — so it's correct even for an instance that never built a reader (e.g. the host's
            // autocompactor) and for streams that grew in place since the index was last loaded.
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

        // ── Pass 2: key-stratify the bulk files to remove duplication. ──
        // Compute the qualifying groups' key ranges once (over a post-pass-1 listing); their key ranges
        // are disjoint, so they stay valid as we merge each in turn.
        const groups = await this.findDuplicateGroups();
        for (const g of groups) {
            // Re-select the files overlapping this group's key range now (earlier merges shifted the set).
            const { bulkFiles } = await this.listFiles();
            const headers = await Promise.all(bulkFiles.map(f => this.readBulkHeader(f.fileName)));
            const groupFiles = bulkFiles.filter((f, i) => {
                const h = headers[i];
                if (!h) return false;
                // Old files without a key range are treated as spanning all keys (so always overlap).
                if (h.minKey === undefined || h.maxKey === undefined) return true;
                return h.minKey <= g.hi && h.maxKey >= g.lo;
            });
            if (groupFiles.length >= 2) { if (!await runMerge(groupFiles, [])) return merged; }
        }

        return merged;
    }

    // Finds key-range groups worth deduping: sorts all bulk keys, walks them in ~KEY_GROUP_BYTES groups,
    // and returns the [lo, hi] of every group whose duplicate (multi-file) key fraction exceeds
    // DUP_THRESHOLD, highest-duplication first (most benefit). Empty when nothing is worth it.
    private async findDuplicateGroups(): Promise<{ lo: string; hi: string; dup: number }[]> {
        const { bulkFiles } = await this.listFiles();
        if (bulkFiles.length < 2) return [];
        const infos = await Promise.all(bulkFiles.map(async f => {
            try {
                const reader = await this.loadFileReader(f.fileName);
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
            const c = keyCount.get(sortedKeys[i])!;
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
        const r = await this.readWithReload(reader => reader.getSingleField(key, col));
        time = Date.now() - time;
        if (time > 50) {
            console.log(`${blue(`${this.name}.getSingleFieldObj(${JSON.stringify(key)}, ${JSON.stringify(column)})`)} took ${red(formatTime(time))} ${this.formatInfo(await this.reader())}`);
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
        const col = String(column);
        const cached = this.columnCache.get(col);
        if (cached) return cached as { key: string; value: T[Column]; time: number }[];
        const gen = this.dataGen;
        let time = Date.now();
        let base = await this.readWithReload(reader => reader.getColumn(col));
        let result = this.patchColumn(base, col) as { key: string; value: T[Column]; time: number }[];
        time = Date.now() - time;
        if (time > 50) {
            console.log(`${blue(`${this.name}.getColumn(${JSON.stringify(column)})`)} took ${red(formatTime(time))} ${this.formatInfo(await this.reader())}`);
        }
        Object.freeze(result);
        // Only cache if no write/reset happened during the awaits above (else this result may be stale).
        if (this.dataGen === gen) this.columnCache.set(col, result);
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
    // Last-known sync base values, kept across a reader reset so a reload/compact serves the previous data
    // instead of flashing empty while the fresh value reloads in the background. Each entry is dropped once
    // ensureBase* has the corresponding fresh value (so reads transition old → new, never old → empty → new).
    private staleBaseColumns = new Map<string, { key: string; value: unknown; time: number }[]>();
    private staleBaseFields = new Map<string, { value: unknown; time: number } | undefined>();

    private ensureBaseColumn(column: string) {
        if (this.baseColumns.has(column) || this.baseColumnsLoading.has(column)) return;
        this.baseColumnsLoading.add(column);
        void (async () => {
            try {
                const base = await this.readWithReload(reader => reader.getColumn(column));
                this.deps.batch(() => {
                    this.baseColumns.set(column, base);
                    this.staleBaseColumns.delete(column); // fresh value in hand; stop serving the stale one
                    this.baseColumnsLoading.delete(column);
                    this.invalidateSignal(LOAD_SIGNAL);
                });
            } catch (e) {
                // The load failed (e.g. a file vanished and the reload retry also failed). Clear the loading
                // flag so a later read retries, rather than leaving the column wedged as "loading" forever.
                this.baseColumnsLoading.delete(column);
                console.warn(`${this.name}.getColumnSync(${JSON.stringify(column)}) load failed, will retry: ${(e as Error).message}`);
            }
        })();
    }

    private ensureBaseField(key: string, column: string) {
        let cacheKey = nullJoin(column, key);
        if (this.baseFields.has(cacheKey) || this.baseFieldsLoading.has(cacheKey)) return;
        this.baseFieldsLoading.add(cacheKey);
        void (async () => {
            try {
                const resolved = await this.readWithReload(reader => reader.getSingleField(key, column));
                this.deps.batch(() => {
                    this.baseFields.set(cacheKey, resolved);
                    this.staleBaseFields.delete(cacheKey); // fresh value in hand; stop serving the stale one
                    this.baseFieldsLoading.delete(cacheKey);
                    this.invalidateSignal(LOAD_SIGNAL);
                });
            } catch (e) {
                this.baseFieldsLoading.delete(cacheKey);
                console.warn(`${this.name}.getSingleFieldSync(${JSON.stringify(key)}, ${JSON.stringify(column)}) load failed, will retry: ${(e as Error).message}`);
            }
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
            if (col in entry.value) {
                // Warm the disk-backed base in the background even though the overlay serves this now — so
                // when the overlay is later cleared (e.g. compaction persists it), there's a value to serve
                // and the read doesn't flash empty.
                this.ensureBaseField(key, col);
                return { key, value: entry.value[col] as T[Column], time: entry.time };
            }
            // column not set in the overlay entry — fall through to the base field cache for this column
        }
        let cacheKey = nullJoin(col, key);
        // Use the fresh value if loaded; mid-reload fall back to the last-known one so we don't flash empty.
        let src: Map<string, { value: unknown; time: number } | undefined> | undefined;
        if (this.baseFields.has(cacheKey)) {
            src = this.baseFields;
        } else {
            this.ensureBaseField(key, col);
            src = this.staleBaseFields.has(cacheKey) ? this.staleBaseFields : undefined;
        }
        if (!src) {
            // Genuine first load (nothing known); but an overlay entry makes the key live with this column unset.
            if (entry !== undefined && entry.value !== DELETED) return { key, value: undefined as T[Column], time: entry.time };
            return undefined;
        }
        const base = src.get(cacheKey);
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
        const cached = this.columnCache.get(col);
        if (cached) return cached as { key: string; value: T[Column]; time: number }[];
        let base = this.baseColumns.get(col);
        if (!base) {
            this.ensureBaseColumn(col);
            // Mid-reload: serve the last-known value (patched with the current overlay) so we don't flash
            // empty. Don't cache it — it's stale until ensureBaseColumn swaps in the fresh value.
            const stale = this.staleBaseColumns.get(col);
            if (stale) return this.patchColumn(stale, col) as { key: string; value: T[Column]; time: number }[];
            return undefined; // genuine first load — nothing known yet
        }
        // Synchronous (no awaits) → reads the current overlay and caches it atomically; an observer re-runs
        // (and the cache is cleared) on any later change, so the frozen result is safe to share.
        let result = this.patchColumn(base, col) as { key: string; value: T[Column]; time: number }[];
        Object.freeze(result);
        this.columnCache.set(col, result);
        return result;
    }

    // Reactive: whether (key, column) is available to read synchronously yet. true once it's loaded — we
    // know the answer, whether that's a value, absent, or deleted; false while it's still loading from disk.
    // Pairs with getSingleFieldObjSync, which returns undefined for BOTH "loading" and "absent" — use this
    // to tell them apart (e.g. show a spinner only when this is false). Triggers the load if not started,
    // and (like the sync reads) counts the last-known value served during a reload as loaded.
    public isFieldLoadedSync<Column extends keyof T>(key: string, column: Column): boolean {
        void this.syncSetup();
        this.deps.observe(LOAD_SIGNAL);
        this.deps.observe(key);
        const entry = this.overlay.get(key);
        if (entry !== undefined) {
            if (entry.value === DELETED) return true;          // known: deleted
            if (String(column) in entry.value) return true;    // known: overlay holds this column
            // else: this column falls through to disk — check the base caches below
        }
        const cacheKey = nullJoin(String(column), key);
        if (this.baseFields.has(cacheKey) || this.staleBaseFields.has(cacheKey)) return true;
        this.ensureBaseField(key, String(column));
        return false;
    }

    // Reactive: whether a whole column is available to read synchronously yet (see isFieldLoadedSync).
    public isColumnLoadedSync<Column extends keyof T>(column: Column): boolean {
        void this.syncSetup();
        this.deps.observe(LOAD_SIGNAL);
        this.deps.observe(OVERLAY_SIGNAL);
        const col = String(column);
        if (this.columnCache.has(col) || this.baseColumns.has(col) || this.staleBaseColumns.has(col)) return true;
        this.ensureBaseColumn(col);
        return false;
    }

    public async getColumnInfo() {
        let reader = await this.reader();
        return reader.columns;
    }

    // Raw vs. resolved key counts: how much duplicate/stale key data is sitting on disk that a compact()
    // would collapse. rawKeys counts every key-slot across all loaded files — each set and each delete
    // tombstone (a key written into N files counts N times); finalKeys is the number of live resolved
    // keys (after newest-write-wins and tombstones). Both come straight from the already-loaded reader, so
    // this is ~free. wastedKeys = rawKeys - finalKeys; duplication = rawKeys / finalKeys (well above 1 ⇒
    // fragmented, compaction would shrink it).
    public async getKeyStats(): Promise<{ rawKeys: number; finalKeys: number; wastedKeys: number; duplication: number; readers: number }> {
        const reader = await this.reader();
        const rawKeys = reader.rawKeyCount;
        const finalKeys = reader.keys.length;
        return {
            rawKeys,
            finalKeys,
            wastedKeys: rawKeys - finalKeys,
            duplication: finalKeys ? rawKeys / finalKeys : 0,
            readers: reader.readerCount,
        };
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

    // Per-file breakdown of the collection's on-disk files, read FRESH from disk each call (so it
    // reflects the latest sizes, including stream files still being appended). `bytes` is the actual
    // on-disk (compressed, for bulk) size. Useful for showing collection size / fragmentation, and to
    // decide whether to call tryMergeNow()/compact().
    public async getFileInfo(): Promise<{ files: { name: string; type: "bulk" | "stream"; bytes: number }[]; count: number; totalBytes: number }> {
        const { bulkFiles, streamFiles } = await this.listFiles();
        const storage = await this.storage();
        const sizeOf = async (name: string) => { try { return (await storage.getInfo(name))?.size ?? 0; } catch { return 0; } };
        const files = [
            ...await Promise.all(bulkFiles.map(async f => ({ name: f.fileName, type: "bulk" as const, bytes: await sizeOf(f.fileName) }))),
            ...await Promise.all(streamFiles.map(async f => ({ name: f.fileName, type: "stream" as const, bytes: await sizeOf(f.fileName) }))),
        ];
        return { files, count: files.length, totalBytes: files.reduce((a, f) => a + f.bytes, 0) };
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
    // Total key-slots across every loaded reader — every set AND every delete tombstone (a key stored in
    // N files counts N times) — and how many readers there are. Already in memory after the join, so
    // getKeyStats is ~free; rawKeyCount vs keys.length is how much duplication a compaction would collapse.
    rawKeyCount: number;
    readerCount: number;
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
        rawKeyCount: databases.reduce((acc, db) => acc + db.keyTimes.size + (db.deleteTimes?.size ?? 0), 0),
        readerCount: databases.length,
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
