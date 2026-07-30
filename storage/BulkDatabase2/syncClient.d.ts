export type RemoteWrite = {
    key: string;
    time: number;
    deleted?: boolean;
    value?: unknown;
};
export declare function registerWriterId(id: string): void;
export declare function isSyncSupported(): boolean;
export declare function connect(collection: string, onWrite: (write: RemoteWrite) => void, onSeal?: () => void): Promise<RemoteWrite[]>;
export declare function broadcast(collection: string, write: RemoteWrite): void;
export declare function queryLiveWriters(collection: string, timeoutMs: number): Promise<Set<string> | undefined>;
export declare function broadcastSeal(collection: string): void;
