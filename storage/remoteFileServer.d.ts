export declare function generatePassword(wordCount: number): string;
export type RemoteFileServerOptions = {
    root: string;
    port?: number;
    host?: string;
    password?: string;
    logAccess?: boolean;
};
export type RemoteFileServerHandle = {
    port: number;
    password: string;
    url: string;
    close: () => Promise<void>;
};
export declare function startRemoteFileServer(options: RemoteFileServerOptions): Promise<RemoteFileServerHandle>;
export declare function runFileHoster(): Promise<void>;
