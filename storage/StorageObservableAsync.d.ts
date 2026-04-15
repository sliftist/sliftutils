/** Reruns the code until all StorageSyncs accessed have loaded their values. Not efficient,although will usually be O(values accessed), just due to how loading works (it won't be quadratic). */
export declare function rerunCodeUntilAllLoaded<T>(code: () => T): Promise<T>;
