export declare function DEV_getKeyStorePath(config: {
    appName: string;
    key: string;
}): string;
export declare function DEV_listKeyStoreApps(key: string): string[];
export declare function getKeyStore<T>(appName: string, key: string): {
    get(): T | undefined;
    set(value: T | null): void;
};
