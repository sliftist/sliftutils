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

type FileHeader = {
    rowCount: number;
    columns: { name: string; offset: number; length: number }[];
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

// Past this estimated logical size a single rows array is split across multiple files, so no one
// file (and therefore no single column blob, and no single Buffer.concat) ever approaches the
// ~2GB Buffer length limit. The cap is deliberately the same as the merge cap: 800MB is the most
// we'll ever hold for one file. The estimate is rough on purpose — it only needs to keep each
// chunk comfortably under the limit, not be exact.
const FILE_SPLIT_BYTES = 800 * 1024 * 1024;

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

function buildOneFile(rows: Record<string, unknown>[]): Buffer {
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
    let offset = 0;
    const columns = columnNames.map((name, i) => {
        const entry = { name, offset, length: blobs[i].length };
        offset += blobs[i].length;
        return entry;
    });
    const header: FileHeader = { rowCount: rows.length, columns };
    const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32LE(headerBuf.length, 0);
    return Buffer.concat([lengthPrefix, headerBuf, ...blobs]);
}

// Returns one complete, independent file buffer per chunk of rows. When the caller hands us more
// rows than fit comfortably in one file we partition by row range — each returned buffer is exactly
// what buildOneFile would produce if called with that subset, so the chunks have disjoint keys and
// the caller just writes each as its own file. A normal-sized write returns a single buffer.
export function buildFileBuffer(rows: Record<string, unknown>[]): Buffer[] {
    if (rows.length === 0) return [buildOneFile([])];
    const result: Buffer[] = [];
    let chunkStart = 0;
    let chunkBytes = 0;
    for (let i = 0; i < rows.length; i++) {
        const rowBytes = estimateRowBytes(rows[i]);
        if (i > chunkStart && chunkBytes + rowBytes > FILE_SPLIT_BYTES) {
            result.push(buildOneFile(rows.slice(chunkStart, i)));
            chunkStart = i;
            chunkBytes = 0;
        }
        chunkBytes += rowBytes;
    }
    result.push(buildOneFile(rows.slice(chunkStart)));
    return result;
}

export type BaseBulkDatabaseReader = {
    rowCount: number;
    totalBytes: number;
    // Keys is special, it's always automatically decoded, even though it is stored as a normal column
    keys: string[];
    columns: { column: string; byteSize: number }[];
    // Keys this reader tombstones (deleted). A newer reader's deletion suppresses the key in all
    // older readers. Bulk readers never set this; the tier-0 stream reader does.
    deletedKeys?: Set<string>;
    getColumn: (column: string) => Promise<{
        key: string;
        value: unknown;
    }[]>;
    getSingleField: (key: string, column: string) => Promise<unknown | undefined>;
};

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

    return {
        rowCount,
        totalBytes: config.totalBytes,
        keys,
        columns: header.columns.map(c => ({ column: c.name, byteSize: c.length })),
        async getColumn(column) {
            const values = await readWholeColumn(column);
            return keys.map((key, i) => ({ key, value: values[i] }));
        },
        async getSingleField(key, column) {
            const row = keyIndex.get(key);
            if (row === undefined) return undefined;
            const col = colByName.get(column);
            if (!col) return undefined;
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
            return decodeValue(typeBuf[0], bytes);
        },
    };
}
