import { LoadedIndex } from "./LoadedIndex";
import { DELETED, WriteOverlay } from "./WriteOverlay";
import type { ReactiveDeps } from "./BulkDatabaseBase";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { blue, red } from "socket-function/src/formatting/logColors";

const NULL = String.fromCharCode(0);
const LOAD_SIGNAL = NULL + "load";
const OVERLAY_SIGNAL = NULL + "overlay";
const COMPACTING_SIGNAL = NULL + "compacting";
const TRIGGER_THROTTLE_FIRST_STEP_MS = 16;

function nullJoin(a: string, b: string): string {
    return a + NULL + b;
}

export type ReaderConfig = {
    name: string;
    deps: ReactiveDeps;
    // See BulkDatabase2Config.maxTriggerThrottleMs.
    maxTriggerThrottleMs?: number;
};

// Owns the current LoadedIndex and WriteOverlay and serves every read (async + sync reactive). Apply writes/deletes through applyWrite/applyDelete so the right signals fire. The host swaps in a fresh LoadedIndex atomically via setIndex once the new one has fully built — no lazy rebuild on the next read, no synchronous lag spike.
export class BulkDatabaseReader<T extends { key: string }> {
    constructor(private readonly cfg: ReaderConfig) { }

    public index: LoadedIndex<T> | undefined;
    public readonly overlay = new WriteOverlay();

    private dataGen = 0;
    private columnCache = new Map<string, { key: string; value: unknown; time: number }[]>();

    private pendingSignals = new Set<string>();
    private triggerTimer: ReturnType<typeof setTimeout> | undefined;
    private currentTriggerDelay = 0;
    private lastTriggerTime = 0;

    get name(): string { return this.cfg.name; }
    get deps(): ReactiveDeps { return this.cfg.deps; }
    get dataGeneration(): number { return this.dataGen; }

    setIndex(newIndex: LoadedIndex<T>, options: { dropStaleFallback?: boolean } = {}): void {
        const prev = this.index;
        if (prev && !options.dropStaleFallback) newIndex.inheritStaleFrom(prev);
        this.cfg.deps.batch(() => {
            this.index = newIndex;
            this.overlay.sweepCovered(key => Math.max(
                newIndex.reader.keyTimes.get(key) ?? -Infinity,
                newIndex.reader.deleteTimes.get(key) ?? -Infinity,
            ));
            this.dataGen++;
            this.columnCache.clear();
            this.invalidateSignal(LOAD_SIGNAL);
            this.invalidateSignal(OVERLAY_SIGNAL);
        });
    }

    applyWrite(key: string, row: Record<string, unknown>, time: number): void {
        const wasLive = this.isLiveNow(key);
        const { invalidatedColumns } = this.overlay.writeRow(key, row, time, wasLive);
        this.notifyOverlayMutation(key, invalidatedColumns);
    }

    applyDelete(key: string, time: number): void {
        const wasLive = this.isLiveNow(key);
        const { invalidatedColumns } = this.overlay.deleteKey(key, time, wasLive);
        this.notifyOverlayMutation(key, invalidatedColumns);
    }

    isKeyWatched(key: string): boolean {
        return this.cfg.deps.isObserved?.(key) ?? true;
    }

    isLiveNow(key: string): boolean {
        const e = this.overlay.get(key);
        if (e) return e.value !== DELETED;
        return this.index?.isLive(key) ?? false;
    }

    localTime(key: string): number {
        const e = this.overlay.get(key);
        if (e) return e.time;
        const st = this.index?.streamTimes.get(key);
        if (st !== undefined) return st;
        return -Infinity;
    }

    // Counter (so concurrent / nested merges in the same instance compose correctly). Signal fires immediately, not through the trigger throttle — UI spinners should show right away.
    private compactingCount = 0;
    beginCompaction(): void {
        this.compactingCount++;
        if (this.compactingCount === 1) this.cfg.deps.invalidate(COMPACTING_SIGNAL);
    }
    endCompaction(): void {
        this.compactingCount--;
        if (this.compactingCount === 0) this.cfg.deps.invalidate(COMPACTING_SIGNAL);
    }
    isCompactingSync(): boolean {
        this.cfg.deps.observe(COMPACTING_SIGNAL);
        return this.compactingCount > 0;
    }

    private notifyOverlayMutation(key: string, columns: Iterable<string> | "all"): void {
        this.dataGen++;
        if (columns === "all") this.columnCache.clear();
        else for (const c of columns) this.columnCache.delete(c);
        if (this.cfg.deps.isObserved?.(key) ?? true) this.invalidateSignal(key);
        this.invalidateSignal(OVERLAY_SIGNAL);
    }

    // ── async reads ──────────────────────────────────────────────────────────────────────────────────
    async getKeys(): Promise<string[]> {
        const index = await this.requireIndex();
        if (this.overlay.size === 0) return [...index.keys];
        const set = new Set(index.keys);
        for (const [key, entry] of this.overlay) {
            if (entry.value === DELETED) set.delete(key);
            else set.add(key);
        }
        return [...set];
    }

    async getColumn<C extends keyof T>(column: C): Promise<{ key: string; value: T[C]; time: number }[]> {
        const col = String(column);
        const cached = this.columnCache.get(col);
        if (cached) return cached as { key: string; value: T[C]; time: number }[];
        const gen = this.dataGen;
        const start = Date.now();
        const index = await this.requireIndex();
        let base = await index.getColumn(col);
        let result = this.overlay.patchColumn(base, col) as { key: string; value: T[C]; time: number }[];
        const elapsed = Date.now() - start;
        if (elapsed > 50) {
            console.log(`${blue(`${this.cfg.name}.getColumn(${JSON.stringify(column)})`)} took ${red(formatTime(elapsed))} ${this.formatInfo(index)}`);
        }
        Object.freeze(result);
        if (this.dataGen === gen) this.columnCache.set(col, result);
        return result;
    }

    async getSingleField<C extends keyof T>(key: string, column: C): Promise<T[C] | undefined> {
        return (await this.getSingleFieldObj(key, column))?.value;
    }

    async getSingleFieldObj<C extends keyof T>(key: string, column: C): Promise<{ key: string; value: T[C]; time: number } | undefined> {
        const col = String(column);
        const entry = this.overlay.get(key);
        if (entry !== undefined) {
            if (entry.value === DELETED) return undefined;
            if (col in entry.value) return { key, value: entry.value[col] as T[C], time: entry.time };
        }
        const start = Date.now();
        const index = await this.requireIndex();
        const r = await index.getSingleField(key, col);
        const elapsed = Date.now() - start;
        if (elapsed > 50) {
            console.log(`${blue(`${this.cfg.name}.getSingleFieldObj(${JSON.stringify(key)}, ${JSON.stringify(column)})`)} took ${red(formatTime(elapsed))} ${this.formatInfo(index)}`);
        }
        if (r === undefined) {
            if (entry !== undefined && entry.value !== DELETED) return { key, value: undefined as T[C], time: entry.time };
            return undefined;
        }
        return { key, value: r.value as T[C], time: r.time };
    }

    // ── sync (reactive) reads ────────────────────────────────────────────────────────────────────────
    getSingleFieldSync<C extends keyof T>(key: string, column: C): T[C] | undefined {
        return this.getSingleFieldObjSync(key, column)?.value;
    }

    getSingleFieldObjSync<C extends keyof T>(key: string, column: C): { key: string; value: T[C]; time: number } | undefined {
        this.cfg.deps.observe(LOAD_SIGNAL);
        this.cfg.deps.observe(key);
        const col = String(column);
        const entry = this.overlay.get(key);
        if (entry !== undefined) {
            if (entry.value === DELETED) return undefined;
            if (col in entry.value) {
                this.index?.ensureBaseField(key, col, () => this.invalidateSignal(LOAD_SIGNAL));
                return { key, value: entry.value[col] as T[C], time: entry.time };
            }
        }
        const index = this.index;
        if (!index) {
            if (entry !== undefined && entry.value !== DELETED) return { key, value: undefined as T[C], time: entry.time };
            return undefined;
        }
        const base = index.getBaseField(key, col);
        // Trigger load if not loaded OR loaded only from stale fallback (refresh needed).
        if (!base.loaded || !base.fresh) index.ensureBaseField(key, col, () => this.invalidateSignal(LOAD_SIGNAL));
        if (!base.loaded || base.value === undefined) {
            if (entry !== undefined && entry.value !== DELETED) return { key, value: undefined as T[C], time: entry.time };
            return undefined;
        }
        return { key, value: base.value.value as T[C], time: base.value.time };
    }

    getColumnSync<C extends keyof T>(column: C): { key: string; value: T[C]; time: number }[] | undefined {
        this.cfg.deps.observe(LOAD_SIGNAL);
        this.cfg.deps.observe(OVERLAY_SIGNAL);
        const col = String(column);
        const cached = this.columnCache.get(col);
        if (cached) return cached as { key: string; value: T[C]; time: number }[];
        const index = this.index;
        if (!index) return undefined;
        const base = index.getBaseColumn(col);
        // Trigger load if not fresh (genuine first load OR a stale fallback awaiting refresh).
        if (!base || !base.fresh) index.ensureBaseColumn(col, () => this.invalidateSignal(LOAD_SIGNAL));
        if (!base) return undefined;
        const result = this.overlay.patchColumn(base.entries, col) as { key: string; value: T[C]; time: number }[];
        if (base.fresh) {
            Object.freeze(result);
            this.columnCache.set(col, result);
        }
        return result;
    }

    isFieldLoadedSync<C extends keyof T>(key: string, column: C): boolean {
        this.cfg.deps.observe(LOAD_SIGNAL);
        this.cfg.deps.observe(key);
        const entry = this.overlay.get(key);
        if (entry !== undefined) {
            if (entry.value === DELETED) return true;
            if (String(column) in entry.value) return true;
        }
        const index = this.index;
        if (!index) return false;
        if (index.isBaseFieldLoaded(key, String(column))) return true;
        index.ensureBaseField(key, String(column), () => this.invalidateSignal(LOAD_SIGNAL));
        return false;
    }

    isColumnLoadedSync<C extends keyof T>(column: C): boolean {
        this.cfg.deps.observe(LOAD_SIGNAL);
        this.cfg.deps.observe(OVERLAY_SIGNAL);
        const col = String(column);
        if (this.columnCache.has(col)) return true;
        const index = this.index;
        if (!index) return false;
        if (index.isBaseColumnLoaded(col)) return true;
        index.ensureBaseColumn(col, () => this.invalidateSignal(LOAD_SIGNAL));
        return false;
    }

    // ── helpers ────────────────────────────────────────────────────────────────────────────────────── Both async reads await this. The host wires an `ensureIndex` that triggers the initial build if no index is loaded yet — reads that race the first load all wait on the same promise.
    setEnsureIndex(fn: () => Promise<LoadedIndex<T>>): void { this.ensureIndexFn = fn; }
    private ensureIndexFn: (() => Promise<LoadedIndex<T>>) | undefined;
    private async requireIndex(): Promise<LoadedIndex<T>> {
        if (this.index) return this.index;
        if (!this.ensureIndexFn) throw new Error(`${this.cfg.name}: index not set — call setIndex(...) before reading`);
        return this.ensureIndexFn();
    }

    private formatInfo(index: LoadedIndex<T>): string {
        return `(collection has ${blue(formatNumber(index.reader.rowCount))} rows, ${blue(formatNumber(index.reader.totalBytes))}B)`;
    }

    // Notifications are rampingly delayed under sustained changes (so a high-rate writer can't re-run watchers per change). Underlying data is always current — only the observable notification is batched/delayed.
    private invalidateSignal(signal: string): void {
        const maxMs = this.cfg.maxTriggerThrottleMs ?? 0;
        if (maxMs <= 0) { this.cfg.deps.invalidate(signal); return; }
        this.pendingSignals.add(signal);
        const now = Date.now();
        const lull = now - this.lastTriggerTime > maxMs;
        this.lastTriggerTime = now;
        if (this.triggerTimer !== undefined) return;
        this.currentTriggerDelay = lull ? 0 : Math.min(maxMs, Math.max(TRIGGER_THROTTLE_FIRST_STEP_MS, this.currentTriggerDelay * 2));
        this.triggerTimer = setTimeout(() => { this.triggerTimer = undefined; this.flushSignals(); }, this.currentTriggerDelay);
        (this.triggerTimer as { unref?: () => void }).unref?.();
    }

    private flushSignals(): void {
        if (this.pendingSignals.size === 0) return;
        const signals = [...this.pendingSignals];
        this.pendingSignals.clear();
        this.cfg.deps.batch(() => { for (const s of signals) this.cfg.deps.invalidate(s); });
    }
}

export const READER_SIGNALS = { LOAD: LOAD_SIGNAL, OVERLAY: OVERLAY_SIGNAL };
export { nullJoin };
