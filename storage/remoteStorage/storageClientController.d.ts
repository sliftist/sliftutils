/** Subscribe to server-pushed routing change notifications. Returns the unsubscribe function. */
export declare function onServerRoutingChanged(listener: () => void): () => void;
export declare const StorageClientController: import("socket-function/SocketFunctionTypes").SocketRegistered<{
    routingConfigChanged: () => Promise<void>;
}>;
