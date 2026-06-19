// Best-effort "only one tab merges this collection at a time" guard. This is purely an efficiency
// measure: correctness does NOT depend on it. Reads resolve by per-row write-time, merges write new
// files before deleting consumed ones, and a duplicate-heavy region gets re-merged — so two tabs
// merging at once only waste work and briefly duplicate data, never corrupt or lose it. The lock just
// stops that wasted work. It uses localStorage (shared across same-origin tabs) and is a no-op where
// localStorage is unavailable (Node) — there concurrent merges are harmless, which the Node stress
// tests exercise. localStorage has no atomic compare-and-swap, so we write-then-reread to shrink the
// race window, and a TTL frees a lock left behind by a tab that crashed or closed mid-merge.

const LOCK_TTL_MS = 30 * 1000;

function getLocalStorage(): Storage | undefined {
    try {
        return typeof localStorage !== "undefined" ? localStorage : undefined;
    } catch {
        return undefined; // accessing localStorage can throw (e.g. disabled cookies)
    }
}

function lockKey(collection: string): string {
    return "bulkDatabase2-merge:" + collection;
}

// Returns true if we now hold the lock (or there's no localStorage to coordinate through, in which case
// we proceed — concurrent merges are harmless). Returns false only if a DIFFERENT holder has a fresh
// lock. Re-stamping our own lock always succeeds, so this doubles as a heartbeat: call it periodically
// during a long, spaced-out merge to keep the lock alive (and detect if another tab took it over).
export function tryAcquireMergeLock(collection: string, holderId: string): boolean {
    const ls = getLocalStorage();
    if (!ls) return true;
    const key = lockKey(collection);
    const now = Date.now();
    const existing = ls.getItem(key);
    if (existing && !existing.startsWith(holderId + ":")) {
        const t = parseInt(existing.slice(existing.lastIndexOf(":") + 1), 10);
        if (Number.isFinite(t) && now - t < LOCK_TTL_MS) return false;
    }
    const token = holderId + ":" + now;
    ls.setItem(key, token);
    // Re-read to catch a racing setItem from another tab (best-effort, not atomic).
    return ls.getItem(key) === token;
}

export function releaseMergeLock(collection: string, holderId: string): void {
    const ls = getLocalStorage();
    if (!ls) return;
    const key = lockKey(collection);
    const existing = ls.getItem(key);
    if (existing && existing.startsWith(holderId + ":")) ls.removeItem(key);
}
