import "./accessPage";
export type HostStorageServerConfig = {
    domain: string;
    port: number;
    folder: string;
    cloudflareApiToken?: string;
    cloudflareApiTokenPath?: string;
    lowSpaceThresholdBytes?: number;
};
export declare function hostStorageServer(config: HostStorageServerConfig): Promise<void>;
