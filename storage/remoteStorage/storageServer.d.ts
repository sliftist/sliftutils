import "./accessPage";
export type HostStorageServerConfig = {
    url: string;
    folder: string;
    lowSpaceThresholdBytes?: number;
    internal?: boolean;
    selfSigned?: boolean;
};
export declare function hostStorageServer(config: HostStorageServerConfig): Promise<void>;
