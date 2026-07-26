/// <reference types="node" />
/// <reference types="node" />
import { IArchives, ArchiveFileInfo, ArchivesConfig, ArchivesSyncStatus, ChangesAfterConfig, DelConfig, FindConfig, GetConfig, GetInfoConfig, SetConfig, SetLargeFileConfig, SourceConfig } from "../IArchives";
export declare const DEFAULT_FAST_WRITE_DELAY: number;
export declare const MAX_REMOTE_FAST_BUFFER: number;
export declare class ArchivesDelayed implements IArchives {
    inner: IArchives;
    private delay;
    private pending;
    private stopped;
    /** The instant every pending write must be on the source no matter its delay - our own valid window's end, minus the flush margin (the next window's source has to find the data on handoff). The store binds it; without it there is no deadline, only the delay. */
    private flushBefore?;
    constructor(inner: IArchives, delay: number);
    /** Called by the store that owns this source: fast writes are never delayed past the store's own write window. */
    bindFlushDeadline(flushBefore: () => number): void;
    /** The config changed the delay (fast writes turned on or off, or a different writeDelay). Anything already pending keeps the due time it was accepted with - shortening the delay must not strand it, and lengthening it must not hold it longer than promised. */
    setDelay(delay: number): void;
    getDebugName(): string;
    hasWriteAccess(): Promise<boolean>;
    set(fileName: string, data: Buffer, config?: SetConfig): Promise<string>;
    del(fileName: string, config?: DelConfig): Promise<void>;
    private buffer;
    private deadlinePassed;
    private write;
    /** Writes everything due (its delay elapsed, or the store's window deadline reached). force writes everything, however recent - shutdown and window handoffs cannot leave writes in memory. */
    flush(force?: boolean): Promise<void>;
    private flushDue;
    /** Stops the flush loop, after writing everything still pending. */
    dispose(): Promise<void>;
    get(fileName: string, config?: GetConfig): Promise<Buffer | undefined>;
    get2(fileName: string, config?: GetConfig): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
        url?: string;
    } | {
        data?: undefined;
        writeTime?: undefined;
        size?: undefined;
        url: string;
    } | undefined>;
    getInfo(fileName: string, config?: GetInfoConfig): Promise<{
        writeTime: number;
        size: number;
        url?: string;
    } | undefined>;
    find(prefix: string, config?: FindConfig): Promise<string[]>;
    /** Pending writes are part of the listing: a scan of this source that couldn't see them would conclude the files had vanished from it, and drop them from the scanner's index. */
    findInfo(prefix: string, config?: FindConfig): Promise<ArchiveFileInfo[]>;
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    /** Never buffered: a file too large to hold in memory is exactly the file that must not sit in memory. Any pending write for the path goes first, so the two land in order. */
    setLargeFile(config: SetLargeFileConfig): Promise<void>;
    getURL(path: string): Promise<string>;
    getConfig(): Promise<ArchivesConfig>;
    getSyncStatus(): Promise<ArchivesSyncStatus>;
}
/** How long a source may hold a write. Our own disk and our own storage servers take the SHORT delay however large writeDelay is: they are what cross-node reads and redundancy depend on, and making those wait minutes is not a trade anyone asked for. Everything else (backblaze) takes the full delay, which is where coalescing actually saves money. Not fast -> no delay at all, and no wrapper. */
export declare function sourceWriteDelay(config: {
    sourceConfig?: SourceConfig;
    fast?: boolean;
    writeDelay?: number;
}): number;
/** The delayed wrapper around a source, when it has one - how the store reaches past the delay (to the real disk for large uploads) and flushes on shutdown. */
export declare function asDelayed(source: IArchives): ArchivesDelayed | undefined;
/** The source itself, past any write delay. */
export declare function unwrapDelayed(source: IArchives): IArchives;
