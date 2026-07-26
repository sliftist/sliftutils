import { RemoteConfig } from "../IArchives";
/** Subscribe to server-pushed routing change notifications. Returns the unsubscribe function. */
export declare function onServerRoutingChanged(listener: () => void): () => void;
/** One chain's configs, as getRoutingConfigForName answers from them: the initial in-code config, and a getter for the synchronized one (adopted from the stored routing files, so it changes over time). */
type TrackedChainConfig = {
    configured: RemoteConfig;
    active: () => RemoteConfig;
};
/** Every chain tracks its configs here (see ChainStateManager), so a server can ask what config was intended for a store name. Returns the untrack function. */
export declare function trackChainConfig(entry: TrackedChainConfig): () => void;
export declare const StorageClientController: import("socket-function/SocketFunctionTypes").SocketRegistered<{
    routingConfigChanged: () => Promise<void>;
    getRoutingConfigForName: (config: {
        account: string;
        bucketName: string;
        name: string;
    }) => Promise<RemoteConfig | undefined>;
}>;
export {};
