export const DELETED = Symbol("deleted");

export type OverlayEntry = { time: number; value: Record<string, unknown> | typeof DELETED };

// In-memory pending mutations layered on top of a LoadedIndex. Each entry carries the write's unique timestamp so cross-tab writes can be ordered + the swap can drop entries the new index already covers. Methods that mutate report which columns invalidate ("all" if the key's liveness flipped), so the host can drop the right caches without scanning every column.
export class WriteOverlay {
    private entries = new Map<string, OverlayEntry>();

    get size(): number { return this.entries.size; }
    get(key: string): OverlayEntry | undefined { return this.entries.get(key); }
    has(key: string): boolean { return this.entries.has(key); }
    keys(): IterableIterator<string> { return this.entries.keys(); }
    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }

    writeRow(key: string, row: Record<string, unknown>, time: number, wasLive: boolean): { invalidatedColumns: Iterable<string> | "all" } {
        const existing = this.entries.get(key);
        const value = existing && existing.value !== DELETED ? { ...existing.value, ...row } : { ...row };
        this.entries.set(key, { time, value });
        return { invalidatedColumns: wasLive ? Object.keys(row) : "all" };
    }

    deleteKey(key: string, time: number, wasLive: boolean): { invalidatedColumns: Iterable<string> | "all" } {
        this.entries.set(key, { time, value: DELETED });
        return { invalidatedColumns: wasLive ? "all" : [] };
    }

    clear(): void { this.entries.clear(); }

    // Drop entries the new index already reflects (its keyTime or deleteTime ≥ the entry's time). The remaining entries are writes the index doesn't yet see — they have to keep serving reads.
    sweepCovered(authority: (key: string) => number): void {
        for (const [key, entry] of this.entries) {
            if (entry.time <= authority(key)) this.entries.delete(key);
        }
    }

    // Apply this overlay onto the base column entries. A column-unset overlay entry leaves the base value+time in place (a partial write only overrides the columns it set).
    patchColumn(base: { key: string; value: unknown; time: number }[], column: string): { key: string; value: unknown; time: number }[] {
        if (this.entries.size === 0) return base;
        const map = new Map(base.map(e => [e.key, { value: e.value, time: e.time }]));
        for (const [key, entry] of this.entries) {
            if (entry.value === DELETED) { map.delete(key); continue; }
            if (column in entry.value) map.set(key, { value: entry.value[column], time: entry.time });
            else if (!map.has(key)) map.set(key, { value: undefined, time: entry.time });
        }
        return [...map].map(([key, v]) => ({ key, value: v.value, time: v.time }));
    }
}
