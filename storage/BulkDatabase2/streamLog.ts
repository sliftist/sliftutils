import cborx from "cbor-x";
import { ABSENT, BaseBulkDatabaseReader, encodeValue, RawCell } from "./BulkDatabaseFormat";

// Tier-0 streaming format: an append log of whole-row writes and deletes (row-format, not columnar),
// so small mutations are a single cheap append instead of rewriting a columnar file. Each block is:
//
//   [u32 len][CBOR({ t, v })  or  CBOR({ t, d })][u32 len]
//
// `t` is a per-write unique timestamp (getTimeUnique); `v` is a set row; `d` is a deleted key. Because
// every thread streams to its own file, the only way to recover the global mutation order — needed
// for newest-wins — is a per-write timestamp, with ties broken by file name. The trailing length must
// match the leading one; a torn/incomplete append leaves a mismatched or missing suffix, so we stop
// there and report trailing bad bytes instead of throwing. structuredClone preserves typed arrays.

export const STREAM_EXTENSION = ".stream";

const cborEncoder = new cborx.Encoder({ structuredClone: true });

export type StreamEntry = { time: number; row?: Record<string, unknown>; deletedKey?: string };

function frame(payload: Buffer): Buffer {
    let len = Buffer.alloc(4);
    len.writeUInt32LE(payload.length, 0);
    return Buffer.concat([len, payload, len]);
}

// Framing only — no batching here. BulkDatabase2 coalesces and flushes these framed bytes on a ramping
// per-collection schedule (see streamAppend in BulkDatabaseBase), because the browser File System Access
// API rewrites the whole file on every append, so one-append-per-write is quadratic. The first write
// after a lull still flushes immediately, so a single action then a tab close is saved at once.

// Times are assigned by the caller (BulkDatabase2) so the exact same timestamp lands on disk, in the
// in-memory overlay, and in the cross-tab broadcast — keeping the global write order consistent.
export function frameRows(entries: { time: number; row: Record<string, unknown> }[]): Buffer {
    return Buffer.concat(entries.map(e => frame(Buffer.from(cborEncoder.encode({ t: e.time, v: e.row })))));
}

export function frameDeletes(entries: { time: number; key: string }[]): Buffer {
    return Buffer.concat(entries.map(e => frame(Buffer.from(cborEncoder.encode({ t: e.time, d: e.key })))));
}

export function parseStream(buffer: Buffer): { entries: StreamEntry[]; badBytes: number } {
    let entries: StreamEntry[] = [];
    let pos = 0;
    while (pos + 4 <= buffer.length) {
        let len = buffer.readUInt32LE(pos);
        let payloadStart = pos + 4;
        let suffixStart = payloadStart + len;
        if (suffixStart + 4 > buffer.length) break;
        if (buffer.readUInt32LE(suffixStart) !== len) break;
        let decoded: { t: number; v?: Record<string, unknown>; d?: string } | undefined;
        try {
            decoded = cborEncoder.decode(buffer.subarray(payloadStart, suffixStart));
        } catch {
            break;
        }
        if (decoded && decoded.d !== undefined) entries.push({ time: decoded.t, deletedKey: decoded.d });
        else if (decoded && decoded.v) entries.push({ time: decoded.t, row: decoded.v });
        pos = suffixStart + 4;
    }
    return { entries, badBytes: buffer.length - pos };
}

// Wraps streamed entries (already ordered oldest-first) as a BaseBulkDatabaseReader. Each set MERGES
// its fields onto the key's current row (so a partial write/update only changes the columns it
// includes); a delete tombstones the key (exposed via deletedKeys so the join suppresses it in older
// bulk readers) and resets the merge. A column the merged row never set reads as ABSENT, so the join
// falls through to older readers for it. Also returns the latest timestamp seen per key (live or
// deleted), used for cross-tab conflict resolution.
export function streamReaderFromEntries(entries: StreamEntry[], totalBytes: number): { reader: BaseBulkDatabaseReader; times: Map<string, number> } {
    let byKey = new Map<string, Record<string, unknown>>();
    let deletedKeys = new Set<string>();
    let times = new Map<string, number>();
    for (let entry of entries) {
        if (entry.deletedKey !== undefined) {
            byKey.delete(entry.deletedKey);
            deletedKeys.add(entry.deletedKey);
            times.set(entry.deletedKey, entry.time);
        } else if (entry.row) {
            let key = entry.row.key as string;
            byKey.set(key, { ...byKey.get(key), ...entry.row });
            deletedKeys.delete(key);
            times.set(key, entry.time);
        }
    }
    let keys = [...byKey.keys()];
    let columnNames: string[] = [];
    let seen = new Set<string>();
    for (let row of byKey.values()) {
        for (let field of Object.keys(row)) {
            if (seen.has(field)) continue;
            seen.add(field);
            columnNames.push(field);
        }
    }
    let columns = columnNames.map(column => ({ column, byteSize: 0 }));
    // Per-key tombstone times for the join's delete resolution.
    let deleteTimes = new Map<string, number>();
    for (let key of deletedKeys) deleteTimes.set(key, times.get(key) || 0);
    // Iterate to find min/max — NOT Math.min(...times)/Math.max(...times): spreading a large array as call
    // arguments overflows the stack ("Maximum call stack size exceeded") once a stream has many keys.
    let minTime = Infinity, maxTime = -Infinity;
    for (let t of times.values()) {
        if (t < minTime) minTime = t;
        if (t > maxTime) maxTime = t;
    }
    let reader: BaseBulkDatabaseReader = {
        totalBytes,
        rowCount: keys.length,
        minTime: times.size ? minTime : 0,
        maxTime: times.size ? maxTime : 0,
        keys,
        keyTimes: new Map(keys.map(key => [key, times.get(key) || 0])),
        columns,
        deleteTimes,
        // A key's time is its latest write across all columns (per-key, not per-column). For a column
        // it never set we return ABSENT so the join falls through to an older reader.
        async getColumn(column) {
            return keys.map(key => {
                let row = byKey.get(key);
                return { key, value: row && column in row ? row[column] : ABSENT, time: times.get(key) || 0 };
            });
        },
        async getSingleField(key, column) {
            let row = byKey.get(key);
            if (!row || !(column in row)) return ABSENT;
            return { value: row[column], time: times.get(key) || 0 };
        },
        // Stream values are decoded objects (CBOR), so unlike a bulk file we have to encode them to raw
        // cells here. Stream data is small (tier-0, size-capped), so this is cheap. A column the row never
        // set is omitted (ABSENT → fall through); a stored undefined is kept (a real clear).
        async getRawColumn(column) {
            let map = new Map<string, RawCell>();
            for (let key of keys) {
                let row = byKey.get(key);
                if (!row || !(column in row)) continue;
                map.set(key, encodeValue(row[column]));
            }
            return map;
        },
    };
    return { reader, times };
}
