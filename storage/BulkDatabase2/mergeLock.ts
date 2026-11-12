// Best-effort "only one tab merges this collection at a time" guard. This is purely an efficiency measure: correctness does NOT depend on it. Reads resolve by per-row write-time, merges write new files before deleting consumed ones, and a duplicate-heavy region gets re-merged — so two tabs merging at once only waste work and briefly duplicate data, never corrupt or lose it. The lock just stops that wasted work. It uses localStorage (shared across same-origin tabs) and is a no-op where localStorage is unavailable (Node) — there concurrent merges are harmless, which the Node stress tests exercise. localStorage has no atomic compare-and-swap, so we write-then-reread to shrink the race window, and a TTL frees a lock left behind by a tab that crashed or closed mid-merge.
// 
// File-lock layer (see acquireMergeFileLock at the bottom): for cross-PROCESS safety (different browsers, different machines pointing at the same remote storage), we ALSO write a `.merge-lock` file inside the collection's storage with our ID. The protocol is check-write-wait-recheck — last writer wins after the 15s settle window. The localStorage lock above covers same-origin tabs; this covers everything else (separate processes, remote shared storage).

import type { FileStorage } from "../FileFolderAPI";
import { formatDateTimeDetailed, formatTime } from "socket-function/src/formatting/format";

const LOCK_TTL_MS = 30 * 1000;

export type MergeLockInfo = { holderId: string; expiresInMs: number };

function parseLockToken(token: string): { holderId: string; time: number } | undefined {
    const colon = token.lastIndexOf(":");
    if (colon < 0) return undefined;
    const time = parseInt(token.slice(colon + 1), 10);
    if (!Number.isFinite(time)) return undefined;
    return { holderId: token.slice(0, colon), time };
}

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

// Returns true if we now hold the lock (or there's no localStorage to coordinate through, in which case we proceed — concurrent merges are harmless). Returns false only if a DIFFERENT holder has a fresh lock. Re-stamping our own lock always succeeds, so this doubles as a heartbeat: call it periodically during a long, spaced-out merge to keep the lock alive (and detect if another tab took it over).
export function tryAcquireMergeLock(collection: string, holderId: string): boolean {
    const ls = getLocalStorage();
    if (!ls) return true;
    const key = lockKey(collection);
    const now = Date.now();
    const existing = ls.getItem(key);
    if (existing && !existing.startsWith(holderId + ":")) {
        const parsed = parseLockToken(existing);
        if (parsed && now - parsed.time < LOCK_TTL_MS) return false;
    }
    const token = holderId + ":" + now;
    ls.setItem(key, token);
    // Re-read to catch a racing setItem from another tab (best-effort, not atomic).
    return ls.getItem(key) === token;
}

// Non-mutating look at the tab lock: who holds it and how long until it goes stale (negative = already stale). For logging why a merge was skipped.
export function peekMergeLock(collection: string): MergeLockInfo | undefined {
    const ls = getLocalStorage();
    if (!ls) return undefined;
    const existing = ls.getItem(lockKey(collection));
    if (!existing) return undefined;
    const parsed = parseLockToken(existing);
    if (!parsed) return undefined;
    return { holderId: parsed.holderId, expiresInMs: parsed.time + LOCK_TTL_MS - Date.now() };
}

export function releaseMergeLock(collection: string, holderId: string): void {
    const ls = getLocalStorage();
    if (!ls) return;
    const key = lockKey(collection);
    const existing = ls.getItem(key);
    if (existing && existing.startsWith(holderId + ":")) ls.removeItem(key);
}

// ── File-based lock (cross-process / shared storage) ──────────────────────────────────────────────
const FILE_LOCK_KEY = ".merge-lock";
const FILE_LOCK_TTL_MS = 5 * 60 * 1000;
const FILE_LOCK_SETTLE_MS = 15 * 1000;
const FILE_LOCK_HEARTBEAT_MS = 2 * 60 * 1000;
const MAX_LOGGED_LOCK_CONTENTS = 500;

export type MergeFileLockRead = {
    readAt: number;
    token?: { holderId: string; time: number };
    raw?: string;
    error?: string;
};

async function readMergeFileLock(storage: FileStorage): Promise<MergeFileLockRead> {
    const readAt = Date.now();
    let buf: Buffer | undefined;
    try {
        buf = await storage.get(FILE_LOCK_KEY);
    } catch (e) {
        return { readAt, error: String((e as Error)?.stack ?? e) };
    }
    if (!buf) return { readAt };
    const raw = buf.toString("utf8");
    return { readAt, raw, token: parseLockToken(raw) };
}

// Non-mutating look at the cross-process lock file (see peekMergeLock).
export async function peekMergeFileLock(storage: FileStorage): Promise<MergeLockInfo | undefined> {
    const existing = (await readMergeFileLock(storage)).token;
    if (!existing) return undefined;
    return { holderId: existing.holderId, expiresInMs: existing.time + FILE_LOCK_TTL_MS - Date.now() };
}

async function writeMergeFileLock(storage: FileStorage, holderId: string, time: number): Promise<void> {
    await storage.set(FILE_LOCK_KEY, Buffer.from(`${holderId}:${time}`, "utf8") as Buffer);
}

export type MergeFileLockAttempt = {
    acquired: boolean;
    holderId: string;
    lockPath: string;
    ttlMs: number;
    settleMs: number;
    before: MergeFileLockRead;
    wroteAt?: number;
    after?: MergeFileLockRead;
};

function describeLockRead(read: MergeFileLockRead, ourHolderId: string): string {
    const parts = [`read at ${formatDateTimeDetailed(read.readAt)}`];
    if (read.error) {
        parts.push(`read FAILED: ${read.error}`);
    } else if (read.raw === undefined) {
        parts.push("no lock file");
    } else if (!read.token) {
        parts.push(`unparseable contents ${JSON.stringify(read.raw.slice(0, MAX_LOGGED_LOCK_CONTENTS))} (${read.raw.length} chars)`);
    } else {
        const ageMs = read.readAt - read.token.time;
        parts.push(
            `holder ${read.token.holderId}${read.token.holderId === ourHolderId && " (us)" || ""}`,
            `stamped ${formatDateTimeDetailed(read.token.time)} (${read.token.time})`,
            `age ${formatTime(ageMs)} (${ageMs}ms)`,
            `stale at ${formatDateTimeDetailed(read.token.time + FILE_LOCK_TTL_MS)}`,
            ageMs < FILE_LOCK_TTL_MS && "fresh" || "STALE",
        );
    }
    return parts.join(", ");
}

// Every value the acquire looked at, for logging why a merge was or wasn't allowed.
export function describeMergeFileLockAttempt(attempt: MergeFileLockAttempt): string {
    const lines = [
        `${attempt.acquired && "acquired" || "NOT acquired"} ${attempt.lockPath} as ${attempt.holderId} (pid ${typeof process !== "undefined" && process.pid || "?"}), ttl ${formatTime(attempt.ttlMs)}, settle ${formatTime(attempt.settleMs)}`,
        `  before: ${describeLockRead(attempt.before, attempt.holderId)}`,
    ];
    if (attempt.wroteAt === undefined) {
        lines.push(`  did not write: another holder's lock was fresh`);
    } else {
        lines.push(`  wrote ${attempt.holderId}:${attempt.wroteAt} at ${formatDateTimeDetailed(attempt.wroteAt)}`);
    }
    if (attempt.after) {
        lines.push(`  after settle: ${describeLockRead(attempt.after, attempt.holderId)}`);
    }
    return lines.join("\n");
}

// Acquire the cross-process file lock. acquired is true ONLY if, after writing our ID and waiting FILE_LOCK_SETTLE_MS for concurrent writers to settle, the file still names us. Caller must releaseMergeFileLock() on the same storage + holderId when done.
export async function tryAcquireMergeFileLock(storage: FileStorage, holderId: string, lockPath: string): Promise<MergeFileLockAttempt> {
    const attempt: MergeFileLockAttempt = { acquired: false, holderId, lockPath, ttlMs: FILE_LOCK_TTL_MS, settleMs: FILE_LOCK_SETTLE_MS, before: await readMergeFileLock(storage) };
    const existing = attempt.before.token;
    if (existing && existing.holderId !== holderId && attempt.before.readAt - existing.time < FILE_LOCK_TTL_MS) return attempt;
    attempt.wroteAt = Date.now();
    await writeMergeFileLock(storage, holderId, attempt.wroteAt);
    await new Promise(r => setTimeout(r, FILE_LOCK_SETTLE_MS));
    attempt.after = await readMergeFileLock(storage);
    attempt.acquired = attempt.after.token?.holderId === holderId;
    return attempt;
}

// Keep the lock fresh. The merge might run longer than FILE_LOCK_TTL_MS; without periodic re-stamping, another process would see the lock as stale and acquire it. Returns a stop function the caller calls in `finally`. Heartbeat is best-effort: a failed write is logged but not propagated.
export function startMergeFileLockHeartbeat(storage: FileStorage, holderId: string): () => void {
    const interval = setInterval(() => {
        void writeMergeFileLock(storage, holderId, Date.now()).catch(() => { /* best-effort */ });
    }, FILE_LOCK_HEARTBEAT_MS);
    (interval as { unref?: () => void }).unref?.();
    return () => clearInterval(interval);
}

export async function releaseMergeFileLock(storage: FileStorage, holderId: string): Promise<void> {
    try {
        const existing = (await readMergeFileLock(storage)).token;
        if (existing && existing.holderId === holderId) await storage.remove(FILE_LOCK_KEY);
    } catch { /* ignore */ }
}
