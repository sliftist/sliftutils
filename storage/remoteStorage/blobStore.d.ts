/// <reference types="node" />
/// <reference types="node" />
import { IArchives, ArchiveFileInfo, ArchivesSource, ArchivesSyncStatus, ChangesAfterConfig, FindConfig, HostedConfig, SyncActivity } from "../IArchives";
import { ArchivesDisk } from "../ArchivesDisk";
export declare const DEFAULT_FAST_WRITE_DELAY: number;
export declare const WINDOW_END_FLUSH_MARGIN: number;
export type IBucketStore = {
    /** internal (store-to-store) reads answer purely from the local disk; see GetConfig.internal */
    get2(config: {
        path: string;
        range?: {
            start: number;
            end: number;
        };
        internal?: boolean;
        includeTombstones?: boolean;
    }): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
    } | undefined>;
    /** internal (store-to-store) writes go to the local disk + index with no fan-out; see SetConfig.internal */
    set(config: {
        path: string;
        data: Buffer;
        lastModified?: number;
        forceSetImmutable?: boolean;
        internal?: boolean;
    }): Promise<void>;
    del(config: {
        path: string;
        lastModified?: number;
        internal?: boolean;
    }): Promise<void>;
    getInfo(config: {
        path: string;
        includeTombstones?: boolean;
    }): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo(config: FindConfig & {
        prefix: string;
    }): Promise<ArchiveFileInfo[]>;
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    getSyncStatus?(): Promise<ArchivesSyncStatus>;
    getSyncProgress?(): {
        index: {
            fileCount: number;
            byteCount: number;
        };
        sources: {
            debugName: string;
            fileCount: number;
            byteCount: number;
        }[];
        readerDiskLimit?: number;
        syncing: SyncActivity[];
    };
    computeIndexTotals?(): Promise<{
        fileCount: number;
        byteCount: number;
        sources: {
            debugName: string;
            fileCount: number;
            byteCount: number;
        }[];
    }>;
    /** path/lastModified let the store reject an upload into an immutable bucket before any bytes move */
    startLargeUpload(config?: {
        path?: string;
        lastModified?: number;
    }): Promise<string>;
    appendLargeUpload(config: {
        id: string;
        data: Buffer;
    }): Promise<void>;
    finishLargeUpload(config: {
        id: string;
        path: string;
        lastModified?: number;
    }): Promise<void>;
    cancelLargeUpload(config: {
        id: string;
    }): Promise<void>;
};
/** rawDisk buckets: the disk IS the store. No index, no synchronization, no window/route/immutability validation. */
export declare class RawDiskStore implements IBucketStore {
    private disk;
    constructor(disk: ArchivesDisk);
    get2(config: {
        path: string;
        range?: {
            start: number;
            end: number;
        };
        internal?: boolean;
        includeTombstones?: boolean;
    }): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
    } | undefined>;
    set(config: {
        path: string;
        data: Buffer;
        lastModified?: number;
        forceSetImmutable?: boolean;
        internal?: boolean;
    }): Promise<void>;
    del(config: {
        path: string;
        lastModified?: number;
        internal?: boolean;
    }): Promise<void>;
    getInfo(config: {
        path: string;
        includeTombstones?: boolean;
    }): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo(config: FindConfig & {
        prefix: string;
    }): Promise<ArchiveFileInfo[]>;
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    startLargeUpload(): Promise<string>;
    appendLargeUpload(config: {
        id: string;
        data: Buffer;
    }): Promise<void>;
    finishLargeUpload(config: {
        id: string;
        path: string;
        lastModified?: number;
    }): Promise<void>;
    cancelLargeUpload(config: {
        id: string;
    }): Promise<void>;
}
export type BlobSourceSpec = {
    identity: string;
    url: string;
    validWindow: [number, number];
    route?: [number, number];
    noFullSync?: boolean;
    intermediate?: boolean;
    create: () => IArchives;
};
export declare class BlobStore implements IBucketStore {
    private folder;
    private sources;
    private config?;
    constructor(folder: string, sources: ArchivesSource[], config?: {
        onIndexChanged?: ((key: string) => void) | undefined;
        readerDiskLimit?: number | undefined;
        onWriteCounted?: ((kind: "original" | "flushed", bytes: number) => void) | undefined;
        resolveSourceUrl?: ((url: string) => IArchives) | undefined;
        entries?: HostedConfig[] | undefined;
    } | undefined);
    init: {
        (): Promise<void>;
        reset(): void;
        set(newValue: Promise<void>): void;
    };
    dispose(): Promise<void>;
    get2(config: {
        path: string;
        range?: {
            start: number;
            end: number;
        };
        internal?: boolean;
        includeTombstones?: boolean;
    }): Promise<{
        data: Buffer;
        writeTime: number;
        size: number;
    } | undefined>;
    set(config: {
        path: string;
        data: Buffer;
        lastModified?: number;
        forceSetImmutable?: boolean;
        internal?: boolean;
    }): Promise<void>;
    del(config: {
        path: string;
        lastModified?: number;
        internal?: boolean;
    }): Promise<void>;
    getInfo(config: {
        path: string;
        includeTombstones?: boolean;
    }): Promise<{
        writeTime: number;
        size: number;
    } | undefined>;
    findInfo(config: FindConfig & {
        prefix: string;
    }): Promise<ArchiveFileInfo[]>;
    getChangesAfter2(config: ChangesAfterConfig): Promise<ArchiveFileInfo[]>;
    getSyncStatus(): Promise<ArchivesSyncStatus>;
    /** The cheap always-current totals plus any in-progress background synchronization. */
    getSyncProgress(): {
        index: {
            fileCount: number;
            byteCount: number;
        };
        sources: {
            debugName: string;
            fileCount: number;
            byteCount: number;
        }[];
        readerDiskLimit?: number;
        syncing: SyncActivity[];
    };
    /** Walks the whole index for exact totals - more expensive than getSyncProgress, but immune to any drift in the maintained counters (and loads the index first, so it's never cold zeros). */
    computeIndexTotals(): Promise<{
        fileCount: number;
        byteCount: number;
        sources: {
            debugName: string;
            fileCount: number;
            byteCount: number;
        }[];
    }>;
    /** Applies a config change to the RUNNING store: windows/routes update in place, new sources are added (their sync starts immediately), and removed sources' slots go dead (their scans stop, their index entries drop). The store survives every routine config evolution - it is never destroyed for a source-list change, only for structural flips it cannot express (rawDisk). Pending fast writes are re-capped to the new flush deadline (flushing immediately when it has already passed). */
    updateSources(specs: BlobSourceSpec[], entries?: HostedConfig[]): void;
    /** Rescans our own disk's metadata into the index - used around valid window handoffs, where another process wrote files to the shared folder that our index hasn't seen. */
    rescanBase(): Promise<void>;
    /** A boundary scan of the node that owned (part of) our route in the valid window before ours, when that node is different storage (a disk rescan can't see its writes): just its changes since the boundary neighborhood, with matching values pulled onto our own disk. */
    boundaryScanRemote(source: IArchives, config: {
        since: number;
        route?: [number, number];
    }): Promise<void>;
    startLargeUpload(config?: {
        path?: string;
        lastModified?: number;
    }): Promise<string>;
    appendLargeUpload(config: {
        id: string;
        data: Buffer;
    }): Promise<void>;
    finishLargeUpload(config: {
        id: string;
        path: string;
        lastModified?: number;
    }): Promise<void>;
    cancelLargeUpload(config: {
        id: string;
    }): Promise<void>;
    private stopped;
    private index;
    private mem;
    private indexFileCount;
    private indexByteCount;
    private sourceFileCounts;
    private sourceByteCounts;
    private syncActivities;
    private dirty;
    private overlay;
    private sourceStates;
    private syncStarted;
    private entries;
    private sourcesList;
    private slotSourcesListIndexes;
    private slotRegistrations;
    private isLive;
    private registerSlot;
    private sourcesListIndexOfSlot;
    private slotForSourcesListIndex;
    private getEntryHolder;
    private loadIndex;
    private countEntry;
    private setIndexEntry;
    private deleteIndexEntry;
    private removeSource;
    private flushIndex;
    private assertMutable;
    private assertInternalWriteAccepted;
    private runSourceSync;
    private isDeadIntermediate;
    private scanSource;
    private reconcileSource;
    private updateScanIndex;
    private pollChanges;
    private copySourceFiles;
    private waitForRequiredScans;
    private checkMissingKey;
    private getIndexEntry;
    /** Internal (store-to-store) read: purely the local disk, completely short-circuiting the index and holder resolution - the caller is another store, and chasing OUR remote holders while answering it is how infinite get loops between stores form. No window or route checks: if the bytes are on our disk, the caller may have them. Note fast writes still sitting in the overlay are invisible here; the caller re-finds them after our flush. */
    private getInternal2;
    /** Internal (store-to-store) write: the local disk plus our index, with NO downstream fan-out - the pushing store owns propagation, and fanning its pushes back out is how write loops between stores form. Only-take-latest still applies here. */
    private setInternal;
    private cacheRead;
    private setOrDelete;
    private getWritableSources;
    private writeToSources;
    private getDiskSource;
    private flushOverlay;
    private evicting;
    private enforceDiskLimit;
    private cleanupTombstones;
}
