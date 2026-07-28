/** A live value: what was stored, when it was written (the caller's ordering), and when we last changed it (ours). */
export type LogEntry<T> = {
    value: T;
    time: number;
    changedAt: number;
};
/** A deleted key: when it was deleted, and when we learned. When the key had a live value at deletion time it is MARKED rather than gone - the value (and its original write time) rides along, so the underlying data can still be read and the deletion can be undone (see unmark) until the history is dropped (see dropValue). */
export type LogTombstone<T> = {
    time: number;
    changedAt: number;
    value?: T;
    valueTime?: number;
};
export declare class TransactionFile<T> {
    private filePath;
    constructor(filePath: string);
    private values;
    private deleted;
    private logRecords;
    private pending;
    private flushTimer;
    private writeChain;
    /** Reads the log and replays it into memory. Every other method assumes this has finished. */
    load: {
        (): Promise<void>;
        reset(): void;
        set(newValue: Promise<void>): void;
    };
    /** The live value, or undefined when the key does not exist here (deleted included - a deletion is an absence, see getDeleted for its time). */
    get(key: string): LogEntry<T> | undefined;
    /** When the key was deleted, if it was (value included when the deletion is still marked - see LogTombstone). Absent both here and in get means we have never heard of it. */
    getDeleted(key: string): LogTombstone<T> | undefined;
    /** The time the key last changed either way, or 0 if we have never heard of it - what a new write has to beat. */
    timeOf(key: string): number;
    /** O(1), and counts only what exists. */
    get size(): number;
    get deletedSize(): number;
    /** Live values only. Live, in insertion order - deleting during iteration is safe (JS skips entries removed before they are reached), which is what the passes that walk everything and prune as they go rely on. */
    entries(): IterableIterator<[string, LogEntry<T>]>;
    /** The tombstones, which is a much smaller walk than the values - so expiring them, or listing what was deleted since some time, costs what it should. */
    deletedEntries(): IterableIterator<[string, LogTombstone<T>]>;
    /** Stores a value as of `time` (rounded to whole milliseconds - see applySet). Returns false when something at least as new is already here, in which case nothing changed - an out-of-order write is not an error, it is just late. */
    set(key: string, value: T, time: number): boolean;
    /** Deletes as of `time`, keeping the tombstone. A key that had a live value keeps it in the tombstone as MARKED for deletion (readable and restorable until dropValue). Returns false when something at least as new is already here. */
    delete(key: string, time: number): boolean;
    /** Undoes a marked deletion: the kept value becomes live again, as of `time` (a fresh time, so the restore outranks the deletion everywhere it propagated). Returns false when there is no marked value to restore, or something at least as new is already here. */
    unmark(key: string, time: number): boolean;
    /** Drops a marked deletion's kept value (its history has been physically removed), leaving a plain tombstone with the same delete time. */
    dropValue(key: string): void;
    /** Forgets the key entirely, tombstone included - for a tombstone old enough that nobody needs to hear about the deletion any more, and for an entry that turned out never to have existed. Not a deletion: it leaves nothing behind to propagate. */
    purge(key: string): void;
    private applySet;
    private applyDelete;
    private append;
    private scheduleFlush;
    /** Writes everything pending (rewriting the log first if it has grown too far past what it describes). */
    flush(): Promise<void>;
    private directory;
    private write;
    private appendPending;
    private compact;
}
