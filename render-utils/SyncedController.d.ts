/// <reference types="socket-function" />
import { SocketRegistered } from "socket-function/SocketFunctionTypes";
type RemapFunction<T> = T extends (...args: infer Args) => Promise<infer Return> ? {
    (...args: Args): Return | undefined;
    promise(...args: Args): Promise<Return>;
    refresh(...args: Args): void;
    refreshAll(): void;
    reset(...args: Args): void;
    resetAll(): void;
    isLoading(...args: Args): boolean;
    setCache(cache: {
        args: Args;
        result: Return;
    }): void;
} : T;
export declare function getSyncedController<T extends SocketRegistered>(controller: T, config?: {
    /** When a controller call for a write finishes, we refresh all readers.
     *      - Invalidation is global, across all controllers.
     */
    reads?: {
        [key in keyof T["nodes"][""]]?: string[];
    };
    writes?: {
        [key in keyof T["nodes"][""]]?: string[];
    };
}): {
    (nodeId: string): {
        [fnc in keyof T["nodes"][""]]: RemapFunction<T["nodes"][""][fnc]>;
    } & {
        resetAll(): void;
        refreshAll(): void;
        anyPending(): boolean;
    };
    resetAll(): void;
    refreshAll(): void;
    anyPending(): boolean;
    rerenderAll(): void;
};
export {};
