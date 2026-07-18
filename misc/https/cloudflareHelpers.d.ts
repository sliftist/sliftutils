/// <reference types="node" />
/// <reference types="node" />
export type CloudflareCreds = {
    key: string;
    /** Set for legacy global API keys, which auth via X-Auth-Email/X-Auth-Key. Absent for API tokens, which auth via Authorization: Bearer. */
    email?: string;
};
export declare const getCloudflareCreds: {
    (): Promise<CloudflareCreds>;
    reset(): void;
    set(newValue: Promise<CloudflareCreds>): void;
};
export declare function cloudflareGETCall<T>(path: string, params?: {
    [key: string]: string;
}): Promise<T>;
export declare function cloudflarePOSTCall<T>(path: string, params: {
    [key: string]: unknown;
}): Promise<T>;
export declare function cloudflareCall<T>(path: string, payload: Buffer, method: string): Promise<T>;
