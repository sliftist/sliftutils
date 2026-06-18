import cborx from "cbor-x";
import { BaseBulkDatabaseReader } from "./BulkDatabaseFormat";

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

// We deliberately do NOT batch/debounce writes here — each write is framed and appended (and flushed)
// immediately. If a caller makes many individual writes and that causes lag, the fix is for them to
// call writeBatch/deleteBatch with the whole set, not for us to silently coalesce. Caller-side
// batching is strictly faster than anything we could do (it knows the full set up front), and not
// batching gives the lowest possible latency for callers who genuinely want single writes — which
// matters because the tab can be closed at any moment, so we want each write on disk as soon as
// possible rather than sitting in a pending buffer that a close would lose.

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

// Wraps streamed entries (already ordered oldest-first) as a BaseBulkDatabaseReader. Applies
// set/delete newest-wins: later entries overwrite earlier ones, and a delete tombstones the key
// (exposed via deletedKeys so the join suppresses it in older bulk readers). Also returns the latest
// timestamp seen per key (live or deleted), used for cross-tab conflict resolution.
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
            byKey.set(key, entry.row);
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
    let reader: BaseBulkDatabaseReader = {
        totalBytes,
        rowCount: keys.length,
        keys,
        columns,
        deletedKeys,
        async getColumn(column) {
            return keys.map(key => {
                let row = byKey.get(key);
                return { key, value: row && row[column] };
            });
        },
        async getSingleField(key, column) {
            let row = byKey.get(key);
            return row && row[column];
        },
    };
    return { reader, times };
}
