export type RemoteWrite = {
    key: string;
    time: number;
    deleted?: boolean;
    value?: unknown;
};
export declare function isSyncSupported(): boolean;
export declare function connect(collection: string, onWrite: (write: RemoteWrite) => void): Promise<RemoteWrite[]>;
export declare function broadcast(collection: string, write: RemoteWrite): void;
