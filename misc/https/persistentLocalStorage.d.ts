import { MaybePromise } from "socket-function/src/types";
export declare function getKeyStore<T>(appName: string, key: string): {
    get(): MaybePromise<T | undefined>;
    set(value: T | null): MaybePromise<void>;
};
