import { delay } from "socket-function/src/batching";
import { hasPending } from "../storage/PendingManager";

export function throwDetached(error: unknown): void {
    void Promise.resolve().then(() => {
        throw error;
    });
}

export async function waitForDiskCollectionFlush() {
    await delay(2000);
    while (hasPending()) {
        console.log("Waiting for pending operations to complete...");
        await delay(2000);
    }
}