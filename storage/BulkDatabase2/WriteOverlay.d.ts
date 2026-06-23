export declare const DELETED: unique symbol;
export type OverlayEntry = {
    time: number;
    value: Record<string, unknown> | typeof DELETED;
};
export declare class WriteOverlay {
    private entries;
    get size(): number;
    get(key: string): OverlayEntry | undefined;
    has(key: string): boolean;
    keys(): IterableIterator<string>;
    [Symbol.iterator](): IterableIterator<[string, OverlayEntry]>;
    writeRow(key: string, row: Record<string, unknown>, time: number, wasLive: boolean): {
        invalidatedColumns: Iterable<string> | "all";
    };
    deleteKey(key: string, time: number, wasLive: boolean): {
        invalidatedColumns: Iterable<string> | "all";
    };
    clear(): void;
    sweepCovered(authority: (key: string) => number): void;
    patchColumn(base: {
        key: string;
        value: unknown;
        time: number;
    }[], column: string): {
        key: string;
        value: unknown;
        time: number;
    }[];
}
