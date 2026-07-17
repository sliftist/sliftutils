module.allowclient = true;

import { IArchives, ArchiveFileInfo, ArchivesConfig } from "../IArchives";
import { buildFileUrl } from "./remoteConfig";

// Read-only IArchives over a public bucket's plain-URL form (our storage server's
// /file/<account>/<bucketName>/... route, or a backblaze friendly URL). Used when we have no API
// access to a source. Only single-file reads work: there is no listing, and writes always throw.

export class ArchivesUrl implements IArchives {
    // base is the bucket's public base URL, e.g. https://host:port/file/<account>/<bucketName>
    constructor(private base: string) { }

    public getDebugName() {
        return `url/${this.base}`;
    }

    private readOnlyError(operation: string): Error {
        return new Error(`${operation} is not supported over URL-form access (no API access to this source, only public URL reads). Source: ${this.base}`);
    }

    public async get(fileName: string, config?: { range?: { start: number; end: number } }): Promise<Buffer | undefined> {
        let result = await this.get2(fileName, config);
        return result && result.data || undefined;
    }
    public async get2(fileName: string, config?: { range?: { start: number; end: number } }): Promise<{ data: Buffer; writeTime: number } | undefined> {
        let url = buildFileUrl(this.base, fileName);
        let headers: Record<string, string> = {};
        let range = config?.range;
        if (range) {
            headers["Range"] = `bytes=${range.start}-${range.end - 1}`;
        }
        let response = await fetch(url, { headers });
        if (response.status === 404) return undefined;
        if (!response.ok) {
            throw new Error(`Read of ${url} failed: ${response.status} ${response.statusText}`);
        }
        let data = Buffer.from(await response.arrayBuffer());
        // Servers that don't support ranges (ours doesn't) return the full file with a 200
        if (range && response.status === 200) {
            data = data.subarray(Math.min(range.start, data.length), Math.min(range.end, data.length));
        }
        let lastModified = response.headers.get("last-modified");
        let writeTime = lastModified && new Date(lastModified).getTime() || 0;
        return { data, writeTime };
    }
    public async getInfo(fileName: string): Promise<{ writeTime: number; size: number } | undefined> {
        let result = await this.get2(fileName);
        return result && { writeTime: result.writeTime, size: result.data.length } || undefined;
    }

    public async set(fileName: string, data: Buffer, config?: { lastModified?: number }): Promise<void> {
        throw this.readOnlyError("set");
    }
    public async del(fileName: string): Promise<void> {
        throw this.readOnlyError("del");
    }
    public async setLargeFile(config: { path: string; getNextData(): Promise<Buffer | undefined> }): Promise<void> {
        throw this.readOnlyError("setLargeFile");
    }
    public async find(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<string[]> {
        throw this.readOnlyError("find (listing)");
    }
    public async findInfo(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<ArchiveFileInfo[]> {
        throw this.readOnlyError("findInfo (listing)");
    }

    public async getURL(path: string): Promise<string> {
        return buildFileUrl(this.base, path);
    }
    public async getConfig(): Promise<ArchivesConfig> {
        return {};
    }
}
