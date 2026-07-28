import { runInfinitePoll } from "socket-function/src/batching";
import {
    IArchives, ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, ChangesAfterConfig, DelConfig,
    FindConfig, GetConfig, GetInfoConfig, SetConfig, SetLargeFileConfig, SourceConfig,
} from "../IArchives";

// Fast writes (see spec.md, "fast writes"), as a wrapper around ONE source instead of a buffer smeared through the store: a write returns as soon as it is in memory, and repeated writes to the same path collapse into a single write to the wrapped source. Every read goes through the pending writes first, so a delayed write is still read-your-writes for anyone reading through this wrapper. Each source is wrapped with its OWN delay - our own disk and our own storage servers want a short one (cross-node redundancy should not wait minutes), an expensive external source like backblaze wants the full one.

// Pending writes are checked for their due time this often - fine enough that a flush lands close to its delay rather than one coarse tick later
const FLUSH_POLL = 1000 * 2;
export const DEFAULT_FAST_WRITE_DELAY = 1000 * 60 * 5;
// The most a fast write is held by our own disk or one of our own storage servers, however large the configured writeDelay is - cross-node redundancy and read-your-writes across nodes must not wait minutes
export const MAX_REMOTE_FAST_BUFFER = 1000 * 5;

type PendingWrite = {
    // A zero-length buffer is a pending deletion (an empty file IS a missing file)
    data: Buffer;
    writeTime: number;
    dueAt: number;
    config?: SetConfig;
};

export class ArchivesDelayed implements IArchives {
    private pending = new Map<string, PendingWrite>();
    private stopped = { stop: false };
    /** The instant every pending write must be on the source no matter its delay - our own valid window's end, minus the flush margin (the next window's source has to find the data on handoff). The store binds it; without it there is no deadline, only the delay. */
    private flushBefore?: () => number;

    constructor(
        public inner: IArchives,
        // How long a write is held in memory before it reaches inner. Policy, so it can change on a config edit - see setDelay.
        private delay: number,
    ) {
        runInfinitePoll(FLUSH_POLL, () => this.flushDue(), this.stopped);
    }

    /** Called by the store that owns this source: fast writes are never delayed past the store's own write window. */
    public bindFlushDeadline(flushBefore: () => number): void {
        this.flushBefore = flushBefore;
    }

    /** The config changed the delay (fast writes turned on or off, or a different writeDelay). Anything already pending keeps the due time it was accepted with - shortening the delay must not strand it, and lengthening it must not hold it longer than promised. */
    public setDelay(delay: number): void {
        if (delay === this.delay) return;
        console.log(`Write delay changed for ${this.inner.getDebugName()}: ${this.delay}ms -> ${delay}ms (${this.pending.size} writes pending)`);
        this.delay = delay;
        if (delay <= 0) {
            void this.flush(true).catch((e: Error) => console.error(`Flushing ${this.inner.getDebugName()} after its write delay was turned off failed: ${e.stack ?? e}`));
        }
    }

    public getDebugName(): string {
        return `${this.inner.getDebugName()} (writes delayed ${this.delay}ms)`;
    }

    public async hasWriteAccess(): Promise<boolean> {
        return await this.inner.hasWriteAccess();
    }

    public async set(fileName: string, data: Buffer, config?: SetConfig): Promise<string> {
        if (!data.length) {
            throw new Error(`Empty write refused: set was called with an empty buffer for ${JSON.stringify(fileName)} on ${this.getDebugName()}: an empty file IS a deletion in this system and would read back as missing - call del instead`);
        }
        return await this.buffer(fileName, data, config?.lastModified, config);
    }

    public async del(fileName: string, config?: DelConfig): Promise<void> {
        await this.buffer(fileName, Buffer.alloc(0), config?.lastModified, config);
    }

    // The shared engine of set and del - an empty buffer is exactly a deletion here
    private async buffer(fileName: string, data: Buffer, lastModified: number | undefined, config?: SetConfig): Promise<string> {
        let writeTime = Math.floor(lastModified || Date.now());
        let existing = this.pending.get(fileName);
        // An older write never overwrites a newer one (see IArchives.set) - including against a write still sitting here
        if (existing && writeTime < existing.writeTime) return fileName;
        let dueAt = Date.now() + this.delay;
        if (this.delay <= 0 || this.deadlinePassed()) {
            this.pending.delete(fileName);
            await this.write(fileName, { data, writeTime, dueAt, config });
            return fileName;
        }
        // The write is accepted the moment it is in memory - that IS the point of a fast write
        this.pending.set(fileName, { data, writeTime, dueAt, config });
        return fileName;
    }

    private deadlinePassed(): boolean {
        let deadline = this.flushBefore?.();
        if (deadline === undefined) return false;
        return Date.now() >= deadline;
    }

    private async write(fileName: string, entry: PendingWrite): Promise<void> {
        if (!entry.data.length) {
            await this.inner.del(fileName, { lastModified: entry.writeTime, noChecks: entry.config?.noChecks, internal: entry.config?.internal });
            return;
        }
        await this.inner.set(fileName, entry.data, { ...entry.config, lastModified: entry.writeTime });
    }

    /** Writes everything due (its delay elapsed, or the store's window deadline reached). force writes everything, however recent - shutdown and window handoffs cannot leave writes in memory. */
    public async flush(force?: boolean): Promise<void> {
        let now = Date.now();
        let deadlineReached = force || this.deadlinePassed();
        for (let [fileName, entry] of [...this.pending]) {
            if (!deadlineReached && entry.dueAt > now) continue;
            // Only drop it if it wasn't overwritten while we were writing
            await this.write(fileName, entry);
            if (this.pending.get(fileName) === entry) {
                this.pending.delete(fileName);
            }
        }
    }

    private async flushDue(): Promise<void> {
        if (!this.pending.size) return;
        await this.flush();
    }

    /** Stops the flush loop, after writing everything still pending. */
    public async dispose(): Promise<void> {
        this.stopped.stop = true;
        await this.flush(true);
    }

    public async get(fileName: string, config?: GetConfig): Promise<Buffer | undefined> {
        let result = await this.get2(fileName, config);
        return result && result.data || undefined;
    }

    public async get2(fileName: string, config?: GetConfig): Promise<{ data: Buffer; writeTime: number; size: number; url?: string } | { data?: undefined; writeTime?: undefined; size?: undefined; url: string } | undefined> {
        let entry = this.pending.get(fileName);
        if (entry) {
            // An empty file IS a missing file (tombstone)
            if (!entry.data.length && !config?.includeTombstones) return undefined;
            let data = entry.data;
            let size = data.length;
            let range = config?.range;
            if (range) {
                data = data.subarray(Math.min(range.start, data.length), Math.min(range.end, data.length));
            }
            return { data, writeTime: entry.writeTime, size };
        }
        return await this.inner.get2(fileName, config);
    }

    public async getInfo(fileName: string, config?: GetInfoConfig): Promise<{ writeTime: number; size: number; url?: string } | undefined> {
        let entry = this.pending.get(fileName);
        if (entry) {
            if (!entry.data.length && !config?.includeTombstones) return undefined;
            return { writeTime: entry.writeTime, size: entry.data.length };
        }
        return await this.inner.getInfo(fileName, config);
    }

    public async find(prefix: string, config?: FindConfig): Promise<string[]> {
        return (await this.findInfo(prefix, config)).map(x => x.path);
    }

    /** Pending writes are part of the listing: a scan of this source that couldn't see them would conclude the files had vanished from it, and drop them from the scanner's index. */
    public async findInfo(prefix: string, config?: FindConfig): Promise<ArchiveFileInfo[]> {
        let infos = new Map<string, ArchiveFileInfo>();
        for (let file of await this.inner.findInfo(prefix, config)) {
            infos.set(file.path, file);
        }
        for (let [fileName, entry] of this.pending) {
            if (!fileName.startsWith(prefix)) continue;
            if (!entry.data.length) {
                infos.delete(fileName);
                continue;
            }
            infos.set(fileName, { path: fileName, createTime: entry.writeTime, size: entry.data.length });
        }
        return [...infos.values()];
    }

    public async getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]> {
        let changes = await this.inner.getChangesAfter2(config);
        let seen = new Set(changes.map(x => x.path));
        for (let [fileName, entry] of this.pending) {
            if (entry.writeTime <= config.time) continue;
            if (seen.has(fileName)) continue;
            changes.push({ path: fileName, createTime: entry.writeTime, size: entry.data.length });
        }
        return changes;
    }

    /** Never buffered: a file too large to hold in memory is exactly the file that must not sit in memory. Any pending write for the path goes first, so the two land in order. */
    public async setLargeFile(config: SetLargeFileConfig): Promise<void> {
        let entry = this.pending.get(config.path);
        if (entry) {
            this.pending.delete(config.path);
            await this.write(config.path, entry);
        }
        await this.inner.setLargeFile(config);
    }

    public async getURL(path: string): Promise<string> {
        return await this.inner.getURL(path);
    }
    public async getConfig(): Promise<ArchivesConfig> {
        return await this.inner.getConfig();
    }
    public async getSyncStatus(): Promise<ArchivesSyncStatus> {
        if (!this.inner.getSyncStatus) {
            throw new Error(`getSyncStatus is not supported: ${this.inner.getDebugName()} does not implement it`);
        }
        return await this.inner.getSyncStatus();
    }
}

/** How long a source may hold a write. Our own disk and our own storage servers take the SHORT delay however large writeDelay is: they are what cross-node reads and redundancy depend on, and making those wait minutes is not a trade anyone asked for. Everything else (backblaze) takes the full delay, which is where coalescing actually saves money. Not fast -> no delay at all, and no wrapper. */
export function sourceWriteDelay(config: { sourceConfig?: SourceConfig; fast?: boolean; writeDelay?: number }): number {
    if (!config.fast) return 0;
    let delay = config.writeDelay;
    // A writeDelay of zero is a real choice (no delay at all), so only an omitted delay gets the default
    if (delay === undefined) {
        delay = DEFAULT_FAST_WRITE_DELAY;
    }
    if (!config.sourceConfig || config.sourceConfig.type === "remote") {
        return Math.min(delay, MAX_REMOTE_FAST_BUFFER);
    }
    return delay;
}

/** The delayed wrapper around a source, when it has one - how the store reaches past the delay (to the real disk for large uploads) and flushes on shutdown. */
export function asDelayed(source: IArchives): ArchivesDelayed | undefined {
    if (source instanceof ArchivesDelayed) return source;
    return undefined;
}

/** The source itself, past any write delay. */
export function unwrapDelayed(source: IArchives): IArchives {
    if (source instanceof ArchivesDelayed) return source.inner;
    return source;
}
