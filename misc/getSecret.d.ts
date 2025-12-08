export declare function resetSecret(key: string): void;
export declare const getSecret: {
    (key: string): Promise<string>;
    clear(key: string): void;
    clearAll(): void;
    forceSet(key: string, value: Promise<string>): void;
    getAllKeys(): string[];
    get(key: string): Promise<string> | undefined;
};
