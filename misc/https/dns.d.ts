/** Parses our freshness tag back out of a record comment; 0 (i.e. always stale) when it's absent or unparseable. */
export declare function freshnessTime(comment?: string): number;
export declare const hasDNSWritePermissions: (() => Promise<boolean>) & {
    reset: () => void;
};
export declare const getZoneId: (rootDomain: string) => Promise<string>;
export declare function getRecordsRaw(type: string, key: string): Promise<{
    id: string;
    type: string;
    name: string;
    content: string;
    proxied: boolean;
    modified_on: string;
    comment?: string;
}[]>;
/** Cloudflare's batch endpoint applies deletes, then patches, then posts in a single database transaction. */
export declare function batchRecords(zoneId: string, batch: {
    deletes?: { id: string }[];
    patches?: { id: string; comment?: string }[];
    posts?: { type: string; name: string; content: string; ttl: number; proxied: boolean; comment?: string }[];
}): Promise<void>;
export declare function getRecords(type: string, key: string): Promise<string[]>;
export declare function deleteRecord(type: string, key: string, value: string): Promise<void>;
/** Removes all existing records (unless the record is already present and fresh) */
export declare function setRecord(type: string, key: string, value: string, proxied?: "proxied", staleAfter?: number): Promise<void>;
/** Keeps existing records */
export declare function addRecord(type: string, key: string, value: string, proxied?: "proxied", staleAfter?: number): Promise<void>;
