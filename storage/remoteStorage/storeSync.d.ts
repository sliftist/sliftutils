import { IArchives, ArchivesSyncStatus, SyncActivity } from "../IArchives";
import type { BlobStore } from "./blobStore";
export declare class StoreSync {
    private store;
    private states;
    private activities;
    private evicting;
    private lastAccess;
    constructor(store: BlobStore);
    /** Starts every live source's synchronization, plus the maintenance loops. Called once, by the store's init - the store's index must already be loaded, since scans write straight into it. */
    start(): void;
    /**
     * Asks every peer for the routing config, and takes it if it is newer than ours. This is the whole
     * of configuration propagation: it rides beside the scans rather than being part of them, because
     * one small read is worth doing every few minutes while a full listing is not, and because a
     * config we are missing is what stops everything else from being right.
     *
     * The copy is stored the same way a scan stores anything it pulls - an internal write into our own
     * store - and the store notices that file landing and re-configures itself. Nothing here knows what
     * a config means; it only knows this one file is worth asking for often.
     */
    private pollRoutingConfig;
    /** Stops every source's loops (the store's own stop token stops the maintenance loops). */
    stop(): void;
    /** A slot the store just appended to its sources array: it starts from nothing, so it gets a full scan. */
    addSource(slot: number): void;
    /** The slot stays in the store's arrays forever (running loops hold slot numbers); it just goes dead - loops stop, and its index entries drop (other sources' scans re-find any copy that's still reachable through the new config). */
    removeSource(slot: number): Promise<void>;
    /** Whether a slot is still configured. Dead slots are never scanned, written, or read. */
    isLive(slot: number): boolean;
    getActivities(): SyncActivity[];
    /** A key was just served, so it goes to the back of the eviction queue. */
    noteAccess(key: string): void;
    private entryUnchanged;
    getStatus(): ArchivesSyncStatus;
    /** Listings come straight from the index, so they must wait for our own base source's initial scan (which might lag minutes) before they are trustworthy. The base (local disk) is implicitly required - remote sources are not, they come and go. */
    waitForRequiredScans(): Promise<void>;
    /** Rescans our own disk's metadata into the index - used around valid window handoffs, where another process wrote files to the shared folder that our index hasn't seen. */
    rescanBase(): Promise<void>;
    /** A boundary scan of the node that owned (part of) our route in the valid window before ours, when that node is different storage (a disk rescan can't see its writes): just its changes since the boundary neighborhood, with matching values pulled onto our own disk. */
    boundaryScanRemote(source: IArchives, config: {
        since: number;
        route?: [number, number];
    }): Promise<void>;
    private runSourceSync;
    private scanSource;
    private reconcileSource;
    private updateScanIndex;
    private pollChanges;
    private copySourceFiles;
    private enforceDiskLimit;
    private cleanupTombstones;
}
