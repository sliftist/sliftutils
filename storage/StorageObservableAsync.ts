import { storagePendingAccesses, waitUntilNextLoad } from "./StorageObservable";

/** Reruns the code until all StorageSyncs accessed have loaded their values. Not efficient,although will usually be O(values accessed), just due to how loading works (it won't be quadratic). */
export async function rerunCodeUntilAllLoaded<T>(code: () => T): Promise<T> {
    while (true) {
        let beforeAccesses = storagePendingAccesses.value;
        try {
            let result = await code();
            if (storagePendingAccesses.value === beforeAccesses) {
                return result;
            }
        } catch (error) {
            if (storagePendingAccesses.value === beforeAccesses) {
                throw error;
            }
        }
        console.log(`Rerunning synchronous check as loading starting while evaluating code. Function name`, code);
        await waitUntilNextLoad();
    }
}