/** NOTE: We also generate the domain *.domain */
export declare const getHTTPSCert: {
    (key: string): Promise<{
        key: string;
        cert: string;
    }>;
    clear(key: string): void;
    clearAll(): void;
    forceSet(key: string, value: Promise<{
        key: string;
        cert: string;
    }>): void;
    getAllKeys(): string[];
    get(key: string): Promise<{
        key: string;
        cert: string;
    }> | undefined;
};
