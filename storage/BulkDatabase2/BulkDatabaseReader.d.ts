import { LoadedIndex } from "./LoadedIndex";
import { WriteOverlay } from "./WriteOverlay";
import type { ReactiveDeps } from "./BulkDatabaseBase";
declare function nullJoin(a: string, b: string): string;
export type ReaderConfig = {
    name: string;
    deps: ReactiveDeps;
    maxTriggerThrottleMs?: number;
};
export declare class BulkDatabaseReader<T extends {
    key: string;
}> {
    private readonly cfg;
    constructor(cfg: ReaderConfig);
    index: LoadedIndex<T> | undefined;
    readonly overlay: WriteOverlay;
    private dataGen;
    private columnCache;
    private pendingSignals;
    private triggerTimer;
    private currentTriggerDelay;
    private lastTriggerTime;
    get name(): string;
    get deps(): ReactiveDeps;
    get dataGeneration(): number;
    setIndex(newIndex: LoadedIndex<T>, options?: {
        dropStaleFallback?: boolean;
    }): void;
    applyWrite(key: string, row: Record<string, unknown>, time: number): void;
    applyDelete(key: string, time: number): void;
    isKeyWatched(key: string): boolean;
    isLiveNow(key: string): boolean;
    localTime(key: string): number;
    private compactingCount;
    beginCompaction(): void;
    endCompaction(): void;
    isCompactingSync(): boolean;
    private notifyOverlayMutation;
    getKeys(): Promise<string[]>;
    getColumn<C extends keyof T>(column: C): Promise<{
        key: string;
        value: T[C];
        time: number;
    }[]>;
    getSingleField<C extends keyof T>(key: string, column: C): Promise<T[C] | undefined>;
    getSingleFieldObj<C extends keyof T>(key: string, column: C): Promise<{
        key: string;
        value: T[C];
        time: number;
    } | undefined>;
    getSingleFieldSync<C extends keyof T>(key: string, column: C): T[C] | undefined;
    getSingleFieldObjSync<C extends keyof T>(key: string, column: C): {
        key: string;
        value: T[C];
        time: number;
    } | undefined;
    getColumnSync<C extends keyof T>(column: C): {
        key: string;
        value: T[C];
        time: number;
    }[] | undefined;
    isFieldLoadedSync<C extends keyof T>(key: string, column: C): boolean;
    isColumnLoadedSync<C extends keyof T>(column: C): boolean;
    setEnsureIndex(fn: () => Promise<LoadedIndex<T>>): void;
    private ensureIndexFn;
    private requireIndex;
    private formatInfo;
    private invalidateSignal;
    private flushSignals;
}
export declare const READER_SIGNALS: {
    LOAD: string;
    OVERLAY: string;
};
export { nullJoin };
