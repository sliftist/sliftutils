import fs from "fs";

const RELOAD_THROTTLE = 5 * 1000;

// The persistent identity behind IndexEntry.sourcesListIndex: an append-only file of source URLs / disk folder paths, one per line, where a URL's 0-based line number IS the sourcesListIndex the index persists. Because the file is only ever appended to, a line number means the same URL forever - across restarts and across processes sharing the folder. A torn append (crash mid-write) leaves an unterminated partial line; the next writer terminates it before appending, so the garbage line permanently occupies its index (harmless - it never matches a real URL) and every reader agrees on the numbering.
export class SourcesList {
    constructor(private filePath: string) { }
    private urls: string[] = [];
    private indexes = new Map<string, number>();
    private endsClean = true;
    private lastReload = 0;
    private appendQueue = Promise.resolve();

    private async load(): Promise<void> {
        let content = "";
        try {
            content = await fs.promises.readFile(this.filePath, "utf8");
        } catch (e) {
            if ((e as { code?: string }).code !== "ENOENT") throw e;
        }
        this.endsClean = !content || content.endsWith("\n");
        let lines = content.split("\n");
        if (lines[lines.length - 1] === "") {
            lines.pop();
        }
        this.urls = lines;
        this.indexes.clear();
        for (let i = 0; i < lines.length; i++) {
            if (!this.indexes.has(lines[i])) {
                this.indexes.set(lines[i], i);
            }
        }
    }

    public getUrl(sourcesListIndex: number): string | undefined {
        return this.urls[sourcesListIndex];
    }

    /** For a sourcesListIndex beyond our in-memory list (another process appended since we read): re-reads the file, at most once per RELOAD_THROTTLE. Returning undefined can therefore mean "throttled", not "definitely absent" - never treat it as proof the index is bogus. */
    public async getUrlReloading(sourcesListIndex: number): Promise<string | undefined> {
        if (sourcesListIndex < this.urls.length) return this.urls[sourcesListIndex];
        if (Date.now() - this.lastReload < RELOAD_THROTTLE) return undefined;
        this.lastReload = Date.now();
        await this.load();
        return this.urls[sourcesListIndex];
    }

    /** The sourcesListIndex of the url, appending it if it is new. Appends are serialized within this process; before each append the file is re-read, so appends by other processes are picked up instead of duplicated. */
    public ensure(url: string): Promise<number> {
        if (url.includes("\n")) {
            throw new Error(`Source URLs cannot contain newlines (they are stored one per line): ${JSON.stringify(url)}`);
        }
        let result = this.appendQueue.then(async () => {
            await this.load();
            let existing = this.indexes.get(url);
            if (existing !== undefined) return existing;
            let prefix = this.endsClean && "" || "\n";
            await fs.promises.appendFile(this.filePath, prefix + url + "\n");
            this.endsClean = true;
            let index = this.urls.length;
            this.urls.push(url);
            this.indexes.set(url, index);
            console.log(`Registered new source ${JSON.stringify(url)} as sourcesListIndex ${index} in ${this.filePath}`);
            return index;
        });
        this.appendQueue = result.then(() => { }, () => { });
        return result;
    }
}
