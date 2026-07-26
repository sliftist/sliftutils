import fs from "fs";
import path from "path";
import { lazy } from "socket-function/src/caching";

// A persistent Map that knows about time and about deletions. Every value carries the time it was written, so a write that arrives out of order is simply not applied - the map cannot be made to go backwards. A deleted key keeps its time too, as a tombstone in a second map, so "was this deleted, and when" is as cheap to ask as "does this exist", and expiring old tombstones is a walk of the tombstones alone rather than of everything.
//
// On disk it is one append-only log of the sets, deletes and purges that produced both maps, rewritten from them whenever it has grown to several times their size.

// The log is rewritten once it holds this many times more records than there are keys (a log of 3 records per surviving key is mostly history)
const COMPACT_RATIO = 3;
// ...but never for a small log, where the rewrite would cost more than the history it removes
const MIN_COMPACT_RECORDS = 1000;
// Appends are coalesced for this long. A crash loses at most this much - the callers of this class treat their data as reconstructible - and the alternative is a file write per set.
const FLUSH_DELAY = 500;

/** A live value: what was stored, when it was written (the caller's ordering), and when we last changed it (ours). */
export type LogEntry<T> = { value: T; time: number; changedAt: number };
/** A deleted key: when it was deleted, and when we learned. The value is gone; the time is the point of a tombstone. */
export type LogTombstone = { time: number; changedAt: number };

// One line of the log. JSON.stringify escapes newlines inside keys and values, so a record can never contain the separator.
type LogRecord<T> = {
    k: string;
    // The caller's time for this change - what ordering is decided by
    t: number;
    // A set carries the value; a delete carries d; a purge carries p (forget the key entirely, tombstone included)
    v?: T;
    d?: 1;
    p?: 1;
};

export class LogMap<T> {
    constructor(private filePath: string) { }

    private values = new Map<string, LogEntry<T>>();
    private deleted = new Map<string, LogTombstone>();
    // Records the log holds (written plus pending) - what compaction is decided against, NOT the number of keys
    private logRecords = 0;
    private pending: string[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | undefined;
    // Serializes everything that touches the file, so an append can never interleave with a rewrite
    private writeChain: Promise<void> = Promise.resolve();

    /** Reads the log and replays it into memory. Every other method assumes this has finished. */
    public load = lazy(async () => {
        let data: string;
        try {
            data = await fs.promises.readFile(this.filePath, "utf8");
        } catch (e) {
            if ((e as { code?: string }).code === "ENOENT") return;
            throw e;
        }
        let applied = 0;
        let damaged = 0;
        for (let line of data.split("\n")) {
            if (!line) continue;
            let record: LogRecord<T> | undefined;
            try {
                record = JSON.parse(line) as LogRecord<T>;
            } catch {
                // A crash mid-append leaves a torn final line; anything earlier means real damage. Either way the rest of the log is still worth having - this is an index, and scanning rebuilds whatever we lose.
                damaged++;
                continue;
            }
            applied++;
            // Replayed through the same ordering rules that produced it, so a log written out of order still lands on the same state
            if (record.p) {
                this.values.delete(record.k);
                this.deleted.delete(record.k);
            } else if (record.d) {
                this.applyDelete(record.k, record.t, record.t);
            } else if (record.v !== undefined) {
                this.applySet(record.k, record.v, record.t, record.t);
            }
        }
        this.logRecords = applied;
        if (damaged) {
            console.error(`${damaged} damaged record(s) in ${this.filePath} were skipped; ${applied} applied, leaving ${this.values.size} values and ${this.deleted.size} tombstones`);
        }
    });

    /** The live value, or undefined when the key does not exist here (deleted included - a deletion is an absence, see getDeleted for its time). */
    public get(key: string): LogEntry<T> | undefined {
        return this.values.get(key);
    }
    /** When the key was deleted, if it was. Absent both here and in get means we have never heard of it. */
    public getDeleted(key: string): LogTombstone | undefined {
        return this.deleted.get(key);
    }
    /** The time the key last changed either way, or 0 if we have never heard of it - what a new write has to beat. */
    public timeOf(key: string): number {
        let live = this.values.get(key);
        if (live) return live.time;
        return this.deleted.get(key)?.time || 0;
    }

    /** O(1), and counts only what exists. */
    public get size(): number {
        return this.values.size;
    }
    public get deletedSize(): number {
        return this.deleted.size;
    }
    /** Live values only. Live, in insertion order - deleting during iteration is safe (JS skips entries removed before they are reached), which is what the passes that walk everything and prune as they go rely on. */
    public entries(): IterableIterator<[string, LogEntry<T>]> {
        return this.values.entries();
    }
    /** The tombstones, which is a much smaller walk than the values - so expiring them, or listing what was deleted since some time, costs what it should. */
    public deletedEntries(): IterableIterator<[string, LogTombstone]> {
        return this.deleted.entries();
    }

    /** Stores a value as of `time`. Returns false when something at least as new is already here, in which case nothing changed - an out-of-order write is not an error, it is just late. */
    public set(key: string, value: T, time: number): boolean {
        if (!this.applySet(key, value, time, Date.now())) return false;
        this.append({ k: key, t: time, v: value });
        return true;
    }

    /** Deletes as of `time`, keeping the tombstone. Returns false when something at least as new is already here. */
    public delete(key: string, time: number): boolean {
        if (!this.applyDelete(key, time, Date.now())) return false;
        this.append({ k: key, t: time, d: 1 });
        return true;
    }

    /** Forgets the key entirely, tombstone included - for a tombstone old enough that nobody needs to hear about the deletion any more, and for an entry that turned out never to have existed. Not a deletion: it leaves nothing behind to propagate. */
    public purge(key: string): void {
        let had = this.values.delete(key);
        had = this.deleted.delete(key) || had;
        if (!had) return;
        this.append({ k: key, t: Date.now(), p: 1 });
    }

    private applySet(key: string, value: T, time: number, changedAt: number): boolean {
        if (time < this.timeOf(key)) return false;
        this.deleted.delete(key);
        this.values.set(key, { value, time, changedAt });
        return true;
    }

    private applyDelete(key: string, time: number, changedAt: number): boolean {
        if (time < this.timeOf(key)) return false;
        this.values.delete(key);
        this.deleted.set(key, { time, changedAt });
        return true;
    }

    private append(record: LogRecord<T>): void {
        this.pending.push(JSON.stringify(record));
        this.logRecords++;
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.flushTimer !== undefined) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            void this.flush().catch((e: Error) => console.error(`Flushing ${this.filePath} failed: ${e.stack ?? e}`));
        }, FLUSH_DELAY);
        (this.flushTimer as { unref?: () => void }).unref?.();
    }

    /** Writes everything pending (rewriting the log first if it has grown too far past what it describes). */
    public async flush(): Promise<void> {
        let result = this.writeChain.then(() => this.write());
        // The chain only exists to serialize writes, so it must not stay rejected: a failure belongs to the caller that asked for this flush, not to every flush after it
        this.writeChain = result.catch(() => { });
        await result;
    }

    private directory = lazy(async () => {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    });

    private async write(): Promise<void> {
        if (this.logRecords > Math.max(MIN_COMPACT_RECORDS, (this.values.size + this.deleted.size) * COMPACT_RATIO)) {
            await this.compact();
            return;
        }
        await this.appendPending();
    }

    private async appendPending(): Promise<void> {
        if (!this.pending.length) return;
        let records = this.pending;
        this.pending = [];
        await this.directory();
        try {
            await fs.promises.appendFile(this.filePath, records.join("\n") + "\n");
        } catch (e) {
            // Put them back rather than lose them: the values are still in memory, so all that is at risk is having to rebuild them by scanning
            this.pending = records.concat(this.pending);
            this.scheduleFlush();
            throw e;
        }
    }

    // Rewrites the log as the current contents of both maps. They are the truth - the log only exists to rebuild them - so the snapshot IS the new log.
    private async compact(): Promise<void> {
        let records: string[] = [];
        for (let [key, entry] of this.values) {
            records.push(JSON.stringify({ k: key, t: entry.time, v: entry.value } satisfies LogRecord<T>));
        }
        for (let [key, tombstone] of this.deleted) {
            records.push(JSON.stringify({ k: key, t: tombstone.time, d: 1 } satisfies LogRecord<T>));
        }
        // Cleared with the snapshot: every pending record is already reflected in the maps, so the snapshot contains it. Anything appended from here on is NOT in the snapshot, and lands in the new log after the rename.
        this.pending = [];
        let startedWith = this.logRecords;
        let tempPath = `${this.filePath}.compacting`;
        await this.directory();
        await fs.promises.writeFile(tempPath, records.length && `${records.join("\n")}\n` || "");
        // Replaces the old log in one step, so a crash leaves either the whole old log or the whole new one
        await fs.promises.rename(tempPath, this.filePath);
        this.logRecords = records.length + this.pending.length;
        console.log(`Rewrote ${this.filePath}: ${startedWith} log records for ${this.values.size} values and ${this.deleted.size} tombstones`);
        await this.appendPending();
    }
}
