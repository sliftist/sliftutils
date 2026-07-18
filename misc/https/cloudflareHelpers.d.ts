export type CloudflareCreds = {
    key: string;
    /** Set for legacy global API keys, which auth via X-Auth-Email/X-Auth-Key. Absent for API tokens, which auth via Authorization: Bearer. */
    email?: string;
};
/** Provide Cloudflare credentials directly instead of relying on ./cloudflare.json. Exactly one of
 *  key (the API token itself) or path (a file to read it from) — TypeScript rejects both/neither. */
export declare function setCloudflareCredentials(config: {
    value: {
        key: string;
    } | {
        path: string;
    };
}): void;
export declare function getCloudflareCreds(): Promise<CloudflareCreds>;
export declare function cloudflareGETCall<T>(path: string, params?: {
    [key: string]: string;
}): Promise<T>;
export declare function cloudflarePOSTCall<T>(path: string, params: {
    [key: string]: unknown;
}): Promise<T>;
export declare function cloudflareCall<T>(path: string, payload: Buffer, method: string): Promise<T>;
