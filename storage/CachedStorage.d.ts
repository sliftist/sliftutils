import { StorageSync } from "./StorageObservable";
export declare function newCachedStrStorage<T>(folder: string, getValue: (key: string) => Promise<T>): StorageSync<T>;
