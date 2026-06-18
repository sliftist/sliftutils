// Best-effort "only one tab merges this collection at a time" guard, layered ON TOP of the manifest
// scheme (which guarantees correctness on its own). This is purely an efficiency measure: it stops two
// tabs doing the same compaction at once and racing to orphan each other's output. It uses
// localStorage (shared across same-origin tabs) and is a no-op where localStorage is unavailable
// (Node) — there the manifest backstop alone keeps things correct, which is also what the Node stress
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

// Returns true if we now hold the lock (or there's no localStorage to coordinate through, in which
// case we proceed and rely on the manifest backstop). Returns false if another tab holds a fresh lock.
export function tryAcquireMergeLock(collection: string, holderId: string): boolean {
    const ls = getLocalStorage();
    if (!ls) return true;
    const key = lockKey(collection);
    const now = Date.now();
    const existing = ls.getItem(key);
    if (existing) {
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
