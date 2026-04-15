export declare function getRecordsRaw(type: string, key: string): Promise<{
    id: string;
    type: string;
    name: string;
    content: string;
    proxied: boolean;
}[]>;
export declare function getRecords(type: string, key: string): Promise<string[]>;
export declare function deleteRecord(type: string, key: string, value: string): Promise<void>;
/** Removes all existing records (unless the record is already present) */
export declare function setRecord(type: string, key: string, value: string, proxied?: "proxied"): Promise<void>;
/** Keeps existing records */
export declare function addRecord(type: string, key: string, value: string, proxied?: "proxied"): Promise<void>;
