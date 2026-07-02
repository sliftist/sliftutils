import { MaybePromise } from "socket-function/src/types";
export declare function getIDBKeyStore<T>(appName: string, key: string): {
    get(): Promise<T | undefined>;
    set(value: T | undefined): Promise<void>;
};
export declare function getKeyStore<T>(appName: string, key: string): {
    get(): MaybePromise<T | undefined>;
    set(value: T | null): MaybePromise<void>;
};
