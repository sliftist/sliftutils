import { TrustRecord } from "./storageController";
import "./accessPage";
export type HostStorageServerConfig = {
    domain: string;
    port: number;
    folder: string;
    cloudflareApiToken?: string;
    cloudflareApiTokenPath?: string;
};
export declare function hostStorageServer(config: HostStorageServerConfig): Promise<void>;
export declare function grantAccessRequest(config: {
    domain: string;
    port: number;
    requestId: string;
}): Promise<TrustRecord>;
