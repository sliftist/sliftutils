import { SocketFunction } from "socket-function/SocketFunction";

// The client half of routing-change broadcasts: the storage server tracks its connected clients (see trackCaller in storageController) and calls routingConfigChanged on every one of them the moment a routing config changes - clients react immediately instead of waiting for a poll.

const listeners = new Set<() => void>();

/** Subscribe to server-pushed routing change notifications. Returns the unsubscribe function. */
export function onServerRoutingChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

class StorageClientControllerBase {
    async routingConfigChanged(): Promise<void> {
        for (let listener of [...listeners]) {
            try {
                listener();
            } catch (e) {
                console.error(`Routing change listener failed: ${(e as Error).stack ?? e}`);
            }
        }
    }
}

export const StorageClientController = SocketFunction.register(
    "StorageClientController-remoteStorage-2b8f1a6d",
    new StorageClientControllerBase(),
    () => ({
        routingConfigChanged: {},
    }),
);
