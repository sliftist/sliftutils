export declare class SourcesList {
    private filePath;
    constructor(filePath: string);
    private urls;
    private indexes;
    private endsClean;
    private lastReload;
    private appendQueue;
    private load;
    getUrl(sourcesListIndex: number): string | undefined;
    /** For a sourcesListIndex beyond our in-memory list (another process appended since we read): re-reads the file, at most once per RELOAD_THROTTLE. Returning undefined can therefore mean "throttled", not "definitely absent" - never treat it as proof the index is bogus. */
    getUrlReloading(sourcesListIndex: number): Promise<string | undefined>;
    /** The sourcesListIndex of the url, appending it if it is new. Appends are serialized within this process; before each append the file is re-read, so appends by other processes are picked up instead of duplicated. */
    ensure(url: string): Promise<number>;
}
