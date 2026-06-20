import { getFileStorageNested2 } from "../FileFolderAPI";
import { observable, runInAction } from "../../render-utils/mobxTyped";
import { BulkDatabaseBase, ReactiveDeps, BulkDatabase2Config } from "./BulkDatabaseBase";

export { BulkDatabaseBase, noopReactiveDeps, bulkDatabase2Timing } from "./BulkDatabaseBase";
export type { ReactiveDeps, StorageFactory, BulkDatabase2Config } from "./BulkDatabaseBase";

/** Per-column on-disk size info, as reported by getColumnInfo/getReaderInfo. */
export type BulkColumnInfo = { column: string; byteSize: number };

/** A snapshot of the collection's shape (no row data), as reported by getReaderInfo. */
export type BulkReaderInfo = {
    rowCount: number;
    totalBytes: number;
    keyCount: number;
    sampleKey: string | undefined;
    columns: BulkColumnInfo[];
};

/**
 * The full public API of BulkDatabase2 (the static `clearCache()` aside). BulkDatabase2 implements
 * this; an application that just wants to depend on the surface can type against this interface instead
 * of reading the implementation. `T` is the row type and must have a string `key`.
 *
 * Reads resolve every key/column by the latest write-time across all storage tiers. Writes are
 * column-merges: a write/update only changes the columns it includes; columns it omits keep their
 * previous value (clear a column by writing it as `undefined`).
 */
export interface IBulkDatabase2<T extends { key: string }> {
    /** The collection name (its folder under the storage root). */
    readonly name: string;

    /** Write one full row (merging its columns onto any existing row for the key). */
    write(entry: T): Promise<void>;
    /** Write many full rows in one batch. */
    writeBatch(entries: T[]): Promise<void>;
    /** Update only the given columns of an existing key (key required). Warns and no-ops if the key isn't present. */
    update(entry: Partial<T> & { key: string }): Promise<void>;
    /** Update many keys' partial columns in one batch. */
    updateBatch(entries: (Partial<T> & { key: string })[]): Promise<void>;
    /** Delete a key. */
    delete(key: string): Promise<void>;
    /** Delete many keys in one batch. */
    deleteBatch(keys: string[]): Promise<void>;

    /** All live keys. */
    getKeys(): Promise<string[]>;
    /** One field's value for a key, or undefined if the key/column isn't set or the key is deleted. */
    getSingleField<Column extends keyof T>(key: string, column: Column): Promise<T[Column] | undefined>;
    /**
     * Like getSingleField but returns { key, value, time } (the same shape a getColumn entry has), where
     * time is roughly when the value last changed. undefined only when the key isn't present/live.
     */
    getSingleFieldObj<Column extends keyof T>(key: string, column: Column): Promise<{ key: string; value: T[Column]; time: number } | undefined>;
    /** A whole column as { key, value, time } for every live key (time ≈ when each value last changed). */
    getColumn<Column extends keyof T>(column: Column): Promise<{ key: string; value: T[Column]; time: number }[]>;

    /**
     * Synchronous, reactive read of one field. Returns undefined while the base value is still loading
     * (and re-renders once it arrives, under a mobx observer); reflects pending writes immediately.
     */
    getSingleFieldSync<Column extends keyof T>(key: string, column: Column): T[Column] | undefined;
    /** Sync, reactive counterpart of getSingleFieldObj: { key, value, time } once loaded, else undefined. */
    getSingleFieldObjSync<Column extends keyof T>(key: string, column: Column): { key: string; value: T[Column]; time: number } | undefined;
    /** Synchronous, reactive read of a whole column ({ key, value, time }). undefined while still loading. */
    getColumnSync<Column extends keyof T>(column: Column): { key: string; value: T[Column]; time: number }[] | undefined;

    /** The columns present on disk and their byte sizes (no row data read). */
    getColumnInfo(): Promise<BulkColumnInfo[]>;
    /** A cheap snapshot of the collection's shape (row/key counts, total bytes, columns) — no row data. */
    getReaderInfo(): Promise<BulkReaderInfo>;
    /**
     * Per-file breakdown of the on-disk files, read fresh from disk each call (latest sizes, including
     * stream files still being appended). `bytes` is the actual on-disk size. Good for showing collection
     * size/fragmentation and deciding whether to call tryMergeNow()/compact().
     */
    getFileInfo(): Promise<{ files: { name: string; type: "bulk" | "stream"; bytes: number }[]; count: number; totalBytes: number }>;

    /** Consolidate on-disk files. Optional to call; the database also does this in the background. */
    compact(): Promise<void>;

    /**
     * Whether this collection's storage is served over the network (a remote server) rather than local
     * disk. Apps can branch on this to adapt to the higher latency. Note: over the network the database
     * skips automatic background compaction by default — call the static
     * `BulkDatabase2.enableNetworkCompaction()` once to opt in.
     */
    isRemote(): Promise<boolean>;

    /**
     * Flush buffered stream writes to disk now. Writes are coalesced and flushed on a ramping delay (to
     * avoid the browser rewriting the whole stream file per write), so a write's promise resolving means
     * "accepted" (in memory + cross-tab), not necessarily "on disk". Call this to force durability — it's
     * also run automatically on tab hide/close and before every merge.
     */
    flush(): Promise<void>;

    /**
     * Run one merge pass now (the same policy the database runs on a timer): consolidate recent
     * fragmentation and dedup a key range if it's worth it. Returns whether it merged anything and
     * whether it bailed because another tab/process holds the merge lock — so a scheduler can call this
     * (e.g. every 30 minutes) and tell "nothing to do" from "someone else is already merging".
     */
    tryMergeNow(): Promise<{ merged: boolean; lockFailed: boolean }>;

    /** Rewrite everything written in [timeLo, timeHi] into fresh key-sorted bulk file(s). Low-level;
     * most callers want compact() or tryMergeNow(). */
    merge(timeLo: number, timeHi: number): Promise<void>;
}

// mobx-backed reactivity: each signal string gets its own observable box. observe() reads it (so an
// observer/autorun that calls it tracks that box) and invalidate() bumps it (so those reactions re-run).
// This reproduces the fine-grained per-key + load-version reactivity the class had when it used
// observable.map/observable.box directly, while keeping all that logic in the mobx-free base.
class MobxReactiveDeps implements ReactiveDeps {
    private boxes = new Map<string, { get(): number; set(value: number): void }>();
    private box(signal: string) {
        let box = this.boxes.get(signal);
        if (!box) {
            box = observable.box(0);
            this.boxes.set(signal, box);
        }
        return box;
    }
    observe(signal: string) {
        this.box(signal).get();
    }
    invalidate(signal: string) {
        let box = this.box(signal);
        box.set(box.get() + 1);
    }
    batch(fn: () => void) {
        runInAction(fn);
    }
}

// Backwards-compatible BulkDatabase2: the mobx-reactive flavor. All behavior lives in BulkDatabaseBase;
// this just supplies mobx reactivity and the default (getFileStorageNested2) storage backend, so the
// sync reads (getSingleFieldSync / getColumnSync) stay observable for mobx components.
export class BulkDatabase2<T extends { key: string }> extends BulkDatabaseBase<T> implements IBulkDatabase2<T> {
    constructor(name: string, config?: BulkDatabase2Config) {
        super(name, new MobxReactiveDeps(), getFileStorageNested2, config);
    }
}
