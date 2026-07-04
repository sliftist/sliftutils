import { BulkDatabaseBase, ReactiveDeps, BulkDatabase2Config, BulkFileInfoListing, MergeAttemptResult } from "./BulkDatabaseBase";
export { BulkDatabaseBase, noopReactiveDeps, bulkDatabase2Timing } from "./BulkDatabaseBase";
export type { ReactiveDeps, StorageFactory, BulkDatabase2Config, BulkFileDetails, BulkFileEntry, BulkFileInfoListing, MergeAttemptResult, MergeSkipReason } from "./BulkDatabaseBase";
/** Per-column on-disk size info, as reported by getColumnInfo/getReaderInfo. */
export type BulkColumnInfo = {
    column: string;
    byteSize: number;
};
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
export interface IBulkDatabase2<T extends {
    key: string;
}> {
    /** The collection name (its folder under the storage root). */
    readonly name: string;
    /** Write one full row (merging its columns onto any existing row for the key). */
    write(entry: T): Promise<void>;
    /** Write many full rows in one batch. */
    writeBatch(entries: T[]): Promise<void>;
    /** Update only the given columns of an existing key (key required). Warns and no-ops if the key isn't present. */
    update(entry: Partial<T> & {
        key: string;
    }): Promise<void>;
    /** Update many keys' partial columns in one batch. */
    updateBatch(entries: (Partial<T> & {
        key: string;
    })[]): Promise<void>;
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
    getSingleFieldObj<Column extends keyof T>(key: string, column: Column): Promise<{
        key: string;
        value: T[Column];
        time: number;
    } | undefined>;
    /** A whole column as { key, value, time } for every live key (time ≈ when each value last changed). */
    getColumn<Column extends keyof T>(column: Column): Promise<{
        key: string;
        value: T[Column];
        time: number;
    }[]>;
    /**
     * Synchronous, reactive read of one field. Returns undefined while the base value is still loading
     * (and re-renders once it arrives, under a mobx observer); reflects pending writes immediately.
     */
    getSingleFieldSync<Column extends keyof T>(key: string, column: Column): T[Column] | undefined;
    /** Sync, reactive counterpart of getSingleFieldObj: { key, value, time } once loaded, else undefined. */
    getSingleFieldObjSync<Column extends keyof T>(key: string, column: Column): {
        key: string;
        value: T[Column];
        time: number;
    } | undefined;
    /** Synchronous, reactive read of a whole column ({ key, value, time }). undefined while still loading. */
    getColumnSync<Column extends keyof T>(column: Column): {
        key: string;
        value: T[Column];
        time: number;
    }[] | undefined;
    /**
     * Reactive: whether (key, column) is loaded yet — true once we know the answer (value, absent, or
     * deleted), false while it's still loading. getSingleFieldObjSync returns undefined for BOTH "loading"
     * and "absent", so use this to tell them apart (e.g. show a spinner only when this is false).
     */
    isFieldLoadedSync<Column extends keyof T>(key: string, column: Column): boolean;
    /** Reactive: whether a whole column is loaded yet (see isFieldLoadedSync). */
    isColumnLoadedSync<Column extends keyof T>(column: Column): boolean;
    /**
     * Reactive: true while a merge is rewriting this collection's files (background `maybeMerge` or
     * an explicit `compact`/`merge`/`tryMergeNow`). Becomes false as soon as the new index is swapped
     * in — the deferred-delete cleanup window is NOT counted. Use this in a UI to show a per-database
     * "compacting…" indicator.
     */
    isCompactingSync(): boolean;
    /**
     * Whether a row (key) is currently being watched by some reactive observer (getSingleFieldObjSync /
     * getSingleFieldSync). Lets callers skip per-row work when nothing's watching. Non-reactive query;
     * returns true if the backend can't tell.
     */
    isKeyWatched(key: string): boolean;
    /**
     * Drop all of this collection's in-memory loaded caches and re-trigger every watcher, which re-requests
     * and reloads from disk. Pending un-flushed writes are kept. Per-collection.
     */
    reloadFromDisk(): void;
    /** The columns present on disk and their byte sizes (no row data read). */
    getColumnInfo(): Promise<BulkColumnInfo[]>;
    /** A cheap snapshot of the collection's shape (row/key counts, total bytes, columns) — no row data. */
    getReaderInfo(): Promise<BulkReaderInfo>;
    /**
     * Per-file breakdown of the on-disk files, read fresh from disk each call (latest sizes, including
     * stream files still being appended). `bytes` is the actual on-disk size. Good for showing collection
     * size/fragmentation and deciding whether to call tryMergeNow()/compact().
     */
    getFileInfo(): Promise<BulkFileInfoListing>;
    /**
     * Consolidate on-disk files. Optional to call; the database also does this in the background.
     * Returns whether anything was merged, or (via skipReason) why the pass never ran — another merge
     * in flight, another tab/process holding the merge lock (with who holds it and when the lock
     * expires), or nothing on disk to compact.
     */
    compact(): Promise<MergeAttemptResult>;
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
     * whether it bailed because another tab/process holds the merge lock (including the lock's holder
     * and expiry) — so a scheduler can call this (e.g. every 30 minutes) and tell "nothing to do" from
     * "someone else is already merging".
     */
    tryMergeNow(): Promise<MergeAttemptResult>;
    /** Rewrite everything written in [timeLo, timeHi] into fresh key-sorted bulk file(s). Low-level;
     * most callers want compact() or tryMergeNow(). */
    merge(timeLo: number, timeHi: number): Promise<void>;
}
export declare class MobxReactiveDeps implements ReactiveDeps {
    private boxes;
    private observed;
    private box;
    observe(signal: string): void;
    invalidate(signal: string): void;
    batch(fn: () => void): void;
    isObserved(signal: string): boolean;
}
export declare class BulkDatabase2<T extends {
    key: string;
}> extends BulkDatabaseBase<T> implements IBulkDatabase2<T> {
    constructor(name: string, config?: BulkDatabase2Config);
}
