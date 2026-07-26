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
    getUrlReloading(sourcesListIndex: number): Promise<string | undefined>;
    ensure(url: string): Promise<number>;
}
