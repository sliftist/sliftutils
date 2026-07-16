import "./accessPage";
export type HostStorageServerConfig = {
    url: string;
    folder: string;
    cloudflareApiToken: {
        key: string;
    } | {
        path: string;
    };
    lowSpaceThresholdBytes?: number;
};
export declare function hostStorageServer(config: HostStorageServerConfig): Promise<void>;
