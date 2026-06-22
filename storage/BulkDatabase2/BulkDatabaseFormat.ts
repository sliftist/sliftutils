// File format (all integers little-endian):
//   u32 headerLength, then headerLength bytes of JSON: { rowCount, columns: [{ name, offset, length }] }, where offset is relative to the end of the header.
//   Each column blob is: u32 offsets[rowCount + 1] (byte offsets into the column's data section), u8 types[rowCount], then the data section (each value's bytes, concatenated).
// Values are encoded with an explicit type tag per value (see the TYPE_ constants). Reads only fetch the byte ranges they need.

export const KEY_COLUMN = "key";

// Every tag is an explicit constant baked into files on disk. NEVER renumber an existing tag — only add new ones — or every previously written file silently decodes wrong.
const TYPE_UNDEFINED = 0;
const TYPE_STRING = 1;
const TYPE_NUMBER = 2;
const TYPE_BOOLEAN = 3;
const TYPE_OBJECT = 4;
const TYPE_INT8_ARRAY = 5;
const TYPE_UINT8_ARRAY = 6;
const TYPE_UINT8_CLAMPED_ARRAY = 7;
const TYPE_INT16_ARRAY = 8;
const TYPE_UINT16_ARRAY = 9;
const TYPE_INT32_ARRAY = 10;
const TYPE_UINT32_ARRAY = 11;
const TYPE_FLOAT32_ARRAY = 12;
const TYPE_FLOAT64_ARRAY = 13;
// A cell whose row never set this column at all — as opposed to TYPE_UNDEFINED, an explicitly stored
// undefined. On read, ABSENT falls through to older readers for that column; a stored undefined stops
// the fall-through (it's a real value that clears the column).
const TYPE_ABSENT = 14;

const TYPED_ARRAY_TYPES: { type: number; ctor: { new(buffer: ArrayBuffer): ArrayBufferView; BYTES_PER_ELEMENT: number; name: string } }[] = [
    { type: TYPE_INT8_ARRAY, ctor: Int8Array },
    { type: TYPE_UINT8_ARRAY, ctor: Uint8Array },
    { type: TYPE_UINT8_CLAMPED_ARRAY, ctor: Uint8ClampedArray },
    { type: TYPE_INT16_ARRAY, ctor: Int16Array },
    { type: TYPE_UINT16_ARRAY, ctor: Uint16Array },
    { type: TYPE_INT32_ARRAY, ctor: Int32Array },
    { type: TYPE_UINT32_ARRAY, ctor: Uint32Array },
    { type: TYPE_FLOAT32_ARRAY, ctor: Float32Array },
    { type: TYPE_FLOAT64_ARRAY, ctor: Float64Array },
];

export const EMPTY_BUFFER = Buffer.alloc(0) as Buffer;

// Sentinel a reader returns for a cell whose row never set this column, so the join can fall through
// to an older reader for that column. Distinct from a stored undefined, which is a real clearing value.
export const ABSENT = Symbol("absent");

// Hidden per-row column holding each row's write-time (so reads can resolve a key to its latest value
// by actual time). NUL-prefixed so it can't collide with a user column; excluded from `columns`.
const TIME_COLUMN = String.fromCharCode(0) + "t";

type FileHeader = {
    rowCount: number;
    columns: { name: string; offset: number; length: number }[];
    // Oldest/newest write-time of the data in this file (from the stream entries it was folded from,
    // carried through merges). Lets the merge planner pick files overlapping a time range. Absent (0)
    // in files written before this existed.
    minTime?: number;
    maxTime?: number;
    // Lexicographically smallest/largest key in this file (rows are stored key-sorted). Lets the merge
    // planner group/dedup by key range and lets a single-key read skip files whose range excludes the
    // key. Absent (undefined) in files written before this existed — treated as "spans all keys".
    minKey?: string;
    maxKey?: string;
};

function encodeValue(value: unknown): { type: number; bytes: Buffer } {
    if (value === ABSENT) {
        return { type: TYPE_ABSENT, bytes: EMPTY_BUFFER };
    }
    if (value === undefined || value === null) {
        return { type: TYPE_UNDEFINED, bytes: EMPTY_BUFFER };
    }
    if (typeof value === "string") {
        return { type: TYPE_STRING, bytes: Buffer.from(value, "utf8") };
    }
    if (typeof value === "number") {
        const bytes = Buffer.alloc(8);
        bytes.writeDoubleLE(value, 0);
        return { type: TYPE_NUMBER, bytes };
    }
    if (typeof value === "boolean") {
        return { type: TYPE_BOOLEAN, bytes: Buffer.from([value && 1 || 0]) };
    }
    if (ArrayBuffer.isView(value)) {
        if (value instanceof DataView) {
            throw new Error(`DataView values are not supported, store a typed array instead`);
        }
        const entry = TYPED_ARRAY_TYPES.find(t => value instanceof t.ctor);
        if (!entry) {
            throw new Error(`Unsupported typed array type ${value.constructor.name}`);
        }
        return {
            type: entry.type,
            bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength),
        };
    }
    if (typeof value !== "object") {
        throw new Error(`Unsupported value type ${typeof value}`);
    }
    return { type: TYPE_OBJECT, bytes: Buffer.from(JSON.stringify(value), "utf8") };
}

function decodeValue(type: number, bytes: Buffer): unknown {
    if (type === TYPE_UNDEFINED) return undefined;
    if (type === TYPE_STRING) return bytes.toString("utf8");
    if (type === TYPE_NUMBER) {
        if (bytes.length !== 8) {
            throw new Error(`Expected 8 bytes for a number, was ${bytes.length}`);
        }
        return bytes.readDoubleLE(0);
    }
    if (type === TYPE_BOOLEAN) {
        if (bytes.length !== 1) {
            throw new Error(`Expected 1 byte for a boolean, was ${bytes.length}`);
        }
        return bytes[0] === 1;
    }
    if (type === TYPE_OBJECT) return JSON.parse(bytes.toString("utf8"));
    if (type === TYPE_ABSENT) return ABSENT;
    const entry = TYPED_ARRAY_TYPES.find(t => t.type === type);
    if (!entry) {
        throw new Error(`Expected a valid type tag, was ${type}`);
    }
    const ctor = entry.ctor;
    if (type === TYPE_UINT8_ARRAY) return Buffer.from(bytes);
    if (bytes.length % ctor.BYTES_PER_ELEMENT !== 0) {
        throw new Error(`Expected byte length divisible by ${ctor.BYTES_PER_ELEMENT} for ${ctor.name}, was ${bytes.length}`);
    }
    // Copy to a fresh ArrayBuffer so the typed array view is aligned regardless of where the bytes landed in the source buffer.
    const aligned = new ArrayBuffer(bytes.length);
    new Uint8Array(aligned).set(bytes);
    return new ctor(aligned);
}

function encodeBulkData(data: unknown[]): Buffer {
    const n = data.length;
    const offsets = Buffer.alloc(4 * (n + 1));
    const types = Buffer.alloc(n);
    const parts: Buffer[] = [];
    let pos = 0;
    for (let i = 0; i < n; i++) {
        const { type, bytes } = encodeValue(data[i]);
        offsets.writeUInt32LE(pos, 4 * i);
        types[i] = type;
        parts.push(bytes);
        pos += bytes.length;
    }
    offsets.writeUInt32LE(pos, 4 * n);
    return Buffer.concat([offsets, types, ...parts]);
}

function decodeBulkData(blob: Buffer, rowCount: number): unknown[] {
    const indexSize = 4 * (rowCount + 1) + rowCount;
    const values: unknown[] = [];
    for (let i = 0; i < rowCount; i++) {
        const start = blob.readUInt32LE(4 * i);
        const end = blob.readUInt32LE(4 * (i + 1));
        const type = blob[4 * (rowCount + 1) + i];
        values.push(decodeValue(type, blob.subarray(indexSize + start, indexSize + end)));
    }
    return values;
}

// Target logical (uncompressed) size of one bulk file. A rows array bigger than this is split across
// multiple key-contiguous files, so files stay around this size (the merge policy's target) and no
// single column blob / Buffer.concat ever approaches the ~2GB Buffer length limit. The estimate is
// rough on purpose — it only needs to keep each chunk near the target, not be exact. A single row
// bigger than the target still becomes its own (oversized) file, since we never split within a key.
export const TARGET_FILE_BYTES = 256 * 1024 * 1024;

// Per-value on-disk overhead: a 4-byte offset entry plus a 1-byte type tag.
const PER_VALUE_OVERHEAD = 5;

function estimateValueBytes(value: unknown): number {
    if (value === undefined || value === null) return 0;
    if (typeof value === "string") return value.length * 2;
    if (typeof value === "number") return 8;
    if (typeof value === "boolean") return 1;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (typeof value === "object") return JSON.stringify(value).length;
    return 0;
}

function estimateRowBytes(row: Record<string, unknown>): number {
    let total = 0;
    for (const value of Object.values(row)) {
        total += estimateValueBytes(value) + PER_VALUE_OVERHEAD;
    }
    return total;
}

function buildOneFile(rows: Record<string, unknown>[], times: number[]): Buffer {
    const columnNames: string[] = [];
    const columnSet = new Set<string>();
    for (const row of rows) {
        for (const field of Object.keys(row)) {
            if (columnSet.has(field)) continue;
            columnSet.add(field);
            columnNames.push(field);
        }
    }
    // A row that doesn't include a column stores ABSENT (fall-through), not undefined (a real value).
    const blobs = columnNames.map(col => encodeBulkData(rows.map(row => col in row ? row[col] : ABSENT)));
    // The hidden per-row time column.
    columnNames.push(TIME_COLUMN);
    blobs.push(encodeBulkData(times));
    let offset = 0;
    const columns = columnNames.map((name, i) => {
        const entry = { name, offset, length: blobs[i].length };
        offset += blobs[i].length;
        return entry;
    });
    let minTime = times.length ? times[0] : 0;
    let maxTime = minTime;
    for (const t of times) { if (t < minTime) minTime = t; if (t > maxTime) maxTime = t; }
    let minKey: string | undefined;
    let maxKey: string | undefined;
    for (const row of rows) {
        const key = row[KEY_COLUMN] as string;
        if (minKey === undefined || key < minKey) minKey = key;
        if (maxKey === undefined || key > maxKey) maxKey = key;
    }
    const header: FileHeader = { rowCount: rows.length, columns, minTime, maxTime, minKey, maxKey };
    const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32LE(headerBuf.length, 0);
    return Buffer.concat([lengthPrefix, headerBuf, ...blobs]);
}

// One complete, independent file: the encoded buffer plus its key range + row count (the caller logs the
// range when a merge splits across several files).
export interface BuiltFile { buffer: Buffer; minKey: string; maxKey: string; rowCount: number; }

// Returns one complete, independent file per chunk of rows. Rows are first sorted by key, then
// partitioned into key-contiguous chunks of ~targetBytes each — so every returned file is key-sorted
// (tight minKey/maxKey for the read-skip + merge planner) and stays near the target size, and no
// single column blob / Buffer.concat approaches the ~2GB limit. The chunks have disjoint key ranges,
// so the caller just writes each as its own file. A normal-sized write returns a single file.
// `times[i]` is row i's write-time, stored per row so reads resolve a key to its latest value by time.
export function buildFileBuffer(rows: Record<string, unknown>[], times: number[], targetBytes = TARGET_FILE_BYTES): BuiltFile[] {
    // A chunk is already key-sorted, so its first/last row are its min/max key.
    const make = (rs: Record<string, unknown>[], ts: number[]): BuiltFile => ({
        buffer: buildOneFile(rs, ts),
        minKey: rs.length ? (rs[0][KEY_COLUMN] as string) : "",
        maxKey: rs.length ? (rs[rs.length - 1][KEY_COLUMN] as string) : "",
        rowCount: rs.length,
    });
    if (rows.length === 0) return [make([], [])];
    // Sort rows + their times together by key so each output file is key-contiguous.
    const order = rows.map((_, i) => i).sort((a, b) => {
        const ka = rows[a][KEY_COLUMN] as string;
        const kb = rows[b][KEY_COLUMN] as string;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const sortedRows = order.map(i => rows[i]);
    const sortedTimes = order.map(i => times[i]);
    const result: BuiltFile[] = [];
    let chunkStart = 0;
    let chunkBytes = 0;
    for (let i = 0; i < sortedRows.length; i++) {
        const rowBytes = estimateRowBytes(sortedRows[i]);
        if (i > chunkStart && chunkBytes + rowBytes > targetBytes) {
            result.push(make(sortedRows.slice(chunkStart, i), sortedTimes.slice(chunkStart, i)));
            chunkStart = i;
            chunkBytes = 0;
        }
        chunkBytes += rowBytes;
    }
    result.push(make(sortedRows.slice(chunkStart), sortedTimes.slice(chunkStart)));
    return result;
}

export type BaseBulkDatabaseReader = {
    rowCount: number;
    totalBytes: number;
    // Write-time bounds of this reader's data (0 if unknown — old bulk files).
    minTime: number;
    maxTime: number;
    // Key-range bounds (undefined for old files / the stream reader — treat as "spans all keys").
    minKey?: string;
    maxKey?: string;
    // Keys is special, it's always automatically decoded, even though it is stored as a normal column
    keys: string[];
    columns: { column: string; byteSize: number }[];
    // Each key's row write-time (the time of its newest write in this reader). The join compares these
    // across readers to resolve a key to its latest value.
    keyTimes: Map<string, number>;
    // Per-key tombstone time: the key was deleted at this time. The join treats a delete like any other
    // event — a delete only wins if it's newer than every set for the key. Only the stream reader sets it.
    deleteTimes?: Map<string, number>;
    // Each key's value for the column plus the row's write-time. value may be ABSENT (the row never set
    // this column — the join then falls through to an older reader for that key/column).
    getColumn: (column: string) => Promise<{ key: string; value: unknown; time: number }[]>;
    // The value + write-time for (key, column), or ABSENT if this reader has no such cell.
    getSingleField: (key: string, column: string) => Promise<{ value: unknown; time: number } | typeof ABSENT>;
};

// Reads just the file header (the 4-byte length + header JSON) — no column data. Used by the merge
// planner to get each file's row count, time range, and key range cheaply across many files.
export type BulkHeaderInfo = { rowCount: number; minTime: number; maxTime: number; minKey?: string; maxKey?: string; columns: { column: string; byteSize: number }[] };
export async function loadBulkHeader(getRange: (start: number, end: number) => Promise<Buffer>, totalBytes: number): Promise<BulkHeaderInfo> {
    const headerLength = (await getRange(0, 4)).readUInt32LE(0);
    if (headerLength <= 0 || headerLength > totalBytes) {
        throw new Error(`Expected header length in (0, ${totalBytes}], was ${headerLength}`);
    }
    const header = JSON.parse((await getRange(4, 4 + headerLength)).toString("utf8")) as FileHeader;
    return {
        rowCount: header.rowCount,
        minTime: header.minTime || 0,
        maxTime: header.maxTime || 0,
        minKey: header.minKey,
        maxKey: header.maxKey,
        columns: header.columns.filter(c => c.name !== TIME_COLUMN).map(c => ({ column: c.name, byteSize: c.length })),
    };
}

export async function loadBulkDatabase(config: {
    totalBytes: number;
    getRange: (start: number, end: number) => Promise<Buffer>;
}): Promise<BaseBulkDatabaseReader> {
    const headerLength = (await config.getRange(0, 4)).readUInt32LE(0);
    if (headerLength <= 0 || headerLength > config.totalBytes) {
        throw new Error(`Expected header length in (0, ${config.totalBytes}], was ${headerLength}`);
    }
    const header = JSON.parse((await config.getRange(4, 4 + headerLength)).toString("utf8")) as FileHeader;
    const dataBase = 4 + headerLength;
    const rowCount = header.rowCount;
    const colByName = new Map(header.columns.map(c => [c.name, c]));

    async function readWholeColumn(column: string): Promise<unknown[]> {
        const col = colByName.get(column);
        if (!col) {
            throw new Error(`Expected column ${column}, file only has: ${header.columns.map(c => c.name).join(", ")}`);
        }
        const blob = await config.getRange(dataBase + col.offset, dataBase + col.offset + col.length);
        return decodeBulkData(blob, rowCount);
    }

    const keys = (await readWholeColumn(KEY_COLUMN)).map(v => {
        if (typeof v !== "string") {
            throw new Error(`Expected string key, was ${typeof v}: ${JSON.stringify(v)?.slice(0, 500)}`);
        }
        return v;
    });
    const keyIndex = new Map(keys.map((key, i) => [key, i]));

    // Per-row write-times. Old files (written before this column existed) fall back to the file's header
    // time (or 0) for every row — fine, since such files predate concurrent-time resolution.
    const times: number[] = colByName.has(TIME_COLUMN)
        ? (await readWholeColumn(TIME_COLUMN)).map(v => typeof v === "number" ? v : 0)
        : keys.map(() => header.maxTime || 0);

    return {
        rowCount,
        totalBytes: config.totalBytes,
        minTime: header.minTime || 0,
        maxTime: header.maxTime || 0,
        minKey: header.minKey,
        maxKey: header.maxKey,
        keys,
        keyTimes: new Map(keys.map((key, i) => [key, times[i]])),
        columns: header.columns.filter(c => c.name !== TIME_COLUMN).map(c => ({ column: c.name, byteSize: c.length })),
        async getColumn(column) {
            const values = await readWholeColumn(column);
            return keys.map((key, i) => ({ key, value: values[i], time: times[i] }));
        },
        async getSingleField(key, column) {
            const row = keyIndex.get(key);
            if (row === undefined) return ABSENT;
            const col = colByName.get(column);
            if (!col) return ABSENT;
            const colBase = dataBase + col.offset;
            const offsetsBuf = await config.getRange(colBase + 4 * row, colBase + 4 * row + 8);
            const start = offsetsBuf.readUInt32LE(0);
            const end = offsetsBuf.readUInt32LE(4);
            const typePos = colBase + 4 * (rowCount + 1) + row;
            const typeBuf = await config.getRange(typePos, typePos + 1);
            const dataStart = colBase + 4 * (rowCount + 1) + rowCount;
            let bytes = EMPTY_BUFFER;
            if (end > start) {
                bytes = await config.getRange(dataStart + start, dataStart + end);
            }
            const value = decodeValue(typeBuf[0], bytes);
            if (value === ABSENT) return ABSENT;
            return { value, time: times[row] };
        },
    };
}
