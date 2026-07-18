/** Parses our tag back out; 0 (i.e. always stale) when it's absent or unparseable. */
export declare function freshnessTime(comment?: string): number;
export declare const hasDNSWritePermissions: {
    (): Promise<boolean>;
    reset(): void;
    set(newValue: Promise<boolean>): void;
};
export declare const getZoneId: {
    (key: string): Promise<string>;
    clear(key: string): void;
    clearAll(): void;
    forceSet(key: string, value: Promise<string>): void;
    getAllKeys(): string[];
    get(key: string): Promise<string> | undefined;
};
export declare function getRecordsRaw(type: string, key: string): Promise<{
    id: string;
    type: string;
    name: string;
    content: string;
    proxied: boolean;
    modified_on: string;
    comment?: string | undefined;
}[]>;
/** Cloudflare's batch endpoint applies deletes, then patches, then posts in a single database
 *   transaction. We route edits (patches) through here because the standalone PATCH/PUT verbs
 *   aren't usable in our setup, and because it lets "remove others + assert target" happen
 *   without a window where the name resolves to nothing. */
export declare function batchRecords(zoneId: string, batch: {
    deletes?: {
        id: string;
    }[];
    patches?: {
        id: string;
        comment?: string;
    }[];
    posts?: {
        type: string;
        name: string;
        content: string;
        ttl: number;
        proxied: boolean;
        comment?: string;
    }[];
}): Promise<void>;
export declare function getRecords(type: string, key: string): Promise<string[]>;
export declare function deleteRecord(type: string, key: string, value: string): Promise<void>;
/** Removes all existing records (unless the record is already present and fresh) */
export declare function setRecord(type: string, key: string, value: string, proxied?: "proxied", staleAfter?: number): Promise<void>;
/** Keeps existing records */
export declare function addRecord(type: string, key: string, value: string, proxied?: "proxied", staleAfter?: number): Promise<void>;
