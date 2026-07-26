import { SocketFunction } from "socket-function/SocketFunction";
import { RemoteConfig } from "../IArchives";
import { parseHostedUrl } from "./remoteConfig";

// The client half of the storage protocol: the storage server tracks its connected clients (see trackCaller in storageController) and calls back into them - routingConfigChanged the moment a routing config changes (clients react immediately instead of waiting for a poll), and getRoutingConfigForName when a store one of our requests created needs the config we intended for it.

const listeners = new Set<() => void>();

/** Subscribe to server-pushed routing change notifications. Returns the unsubscribe function. */
export function onServerRoutingChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** One chain's configs, as getRoutingConfigForName answers from them: the initial in-code config, and a getter for the synchronized one (adopted from the stored routing files, so it changes over time). */
type TrackedChainConfig = { configured: RemoteConfig; active: () => RemoteConfig };
const chainConfigs = new Set<TrackedChainConfig>();

/** Every chain tracks its configs here (see ChainStateManager), so a server can ask what config was intended for a store name. Returns the untrack function. */
export function trackChainConfig(entry: TrackedChainConfig): () => void {
    chainConfigs.add(entry);
    return () => {
        chainConfigs.delete(entry);
    };
}

function configNamesStore(config: RemoteConfig, account: string, bucketName: string, name: string): boolean {
    for (let source of config.sources) {
        if (typeof source === "string" || source.type !== "remote") continue;
        if (source.name !== name) continue;
        try {
            let parsed = parseHostedUrl(source.url);
            if (parsed.account === account && parsed.bucketName === bucketName) return true;
        } catch {
            continue;
        }
    }
    return false;
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

    /** A storage server asks: what routing config did this client INTEND for this store name? This is how a store our requests created - before any config ever reached its folder - configures itself: the same information as passing the config on every call, fetched lazily instead (the config is kilobytes and the calls are many). Preference: the synchronized config (adopted from the stored routing files); when that no longer names the store, the initial in-code config - older, but it MATCHES the name, which is what the asking store needs. */
    async getRoutingConfigForName(config: { account: string; bucketName: string; name: string }): Promise<RemoteConfig | undefined> {
        for (let entry of [...chainConfigs]) {
            let active = entry.active();
            if (configNamesStore(active, config.account, config.bucketName, config.name)) return active;
        }
        for (let entry of [...chainConfigs]) {
            if (configNamesStore(entry.configured, config.account, config.bucketName, config.name)) return entry.configured;
        }
        return undefined;
    }
}

export const StorageClientController = SocketFunction.register(
    "StorageClientController-remoteStorage-2b8f1a6d",
    new StorageClientControllerBase(),
    () => ({
        routingConfigChanged: {},
        getRoutingConfigForName: {},
    }),
);
