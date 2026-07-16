module.allowclient = true;

// The important operations of an archive bucket (extracted from ArchivesBackblaze), so other
// backends (e.g. our own remote storage server) can be used interchangeably.

// createTime is a misnomer kept for compatibility — it is really the LAST-WRITE time, same as
// getInfo's writeTime. Neither Backblaze nor our remote storage tracks a distinct creation date:
// each write stamps a fresh timestamp on the current version, so both fields are just "when the
// bytes served by get() were most recently written".
export type ArchiveFileInfo = { path: string; createTime: number; size: number };

export interface IArchives {
    getDebugName(): string;
    get(fileName: string, config?: { range?: { start: number; end: number } }): Promise<Buffer | undefined>;
    set(fileName: string, data: Buffer): Promise<void>;
    del(fileName: string): Promise<void>;
    /** Streams a file too large to hold in memory. getNextData returns undefined when done. */
    setLargeFile(config: { path: string; getNextData(): Promise<Buffer | undefined> }): Promise<void>;
    /** writeTime is the last-write time — see ArchiveFileInfo.createTime, which is the same value. */
    getInfo(fileName: string): Promise<{ writeTime: number; size: number } | undefined>;
    find(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<string[]>;
    findInfo(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<ArchiveFileInfo[]>;
    /** Only works for public buckets (private buckets are API-access only). */
    getURL(path: string): Promise<string>;
}
