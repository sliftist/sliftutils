import "./accessPage";
export type HostStorageServerConfig = {
    domain: string;
    port: number;
    folder: string;
    cloudflareApiToken?: {
        key: string;
    } | {
        path: string;
    };
    lowSpaceThresholdBytes?: number;
};
export declare function hostStorageServer(config: HostStorageServerConfig): Promise<void>;
