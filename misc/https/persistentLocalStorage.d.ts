export declare function getKeyStore<T>(appName: string, key: string): {
    get(): T | undefined;
    set(value: T | null): void;
};
