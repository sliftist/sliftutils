import { measureWrap } from "socket-function/src/profiling/measure";
import { asBuffer, asFloat32 } from "socket-function/src/buffers";

// The formats an embedding can be stored & compared in. The trailing number is the Matryoshka
// truncation length (the count of leading dimensions kept). "q8gN" means signed int8 values with
// one scale shared across every N dimensions. "float32" keeps the raw (truncated) vector.
export type EmbeddingFormat = "q8g8_2048" | "q8_g16_2048" | "q8_g16_1024" | "float32";

export const EMBEDDING_FORMATS: EmbeddingFormat[] = ["q8g8_2048", "q8_g16_2048", "q8_g16_1024", "float32"];
export const DEFAULT_EMBEDDING_FORMAT: EmbeddingFormat = "q8g8_2048";

// The only element quantization we support right now (signed int8, values in [-127, 127]).
export type QuantType = "q8";

const INT8_MAX = 127;

type FormatConfig = {
    // Leading dimensions kept. undefined keeps the full vector.
    truncation?: number;
    // int8 group quantization parameters. undefined stores the raw float32 vector.
    quant?: { type: QuantType; groupSize: number };
};
const FORMAT_CONFIGS: { [format in EmbeddingFormat]: FormatConfig } = {
    q8g8_2048: { truncation: 2048, quant: { type: "q8", groupSize: 8 } },
    q8_g16_2048: { truncation: 2048, quant: { type: "q8", groupSize: 16 } },
    q8_g16_1024: { truncation: 1024, quant: { type: "q8", groupSize: 16 } },
    float32: {},
};

export type StoredEmbedding = {
    kind: "float32";
    model: string;
    values: Float32Array;
} | {
    kind: "quant";
    model: string;
    // Element quantization. "q8" is signed int8 (values in [-127, 127]).
    type: QuantType;
    // Number of consecutive dimensions sharing one scale.
    groupSize: number;
    // int8 values (one per kept dimension), reinterpreted as raw bytes.
    data: Uint8Array;
    // float16 scales (one per group), reinterpreted as raw bytes.
    scales: Uint8Array;
};

type QuantEmbedding = Extract<StoredEmbedding, { kind: "quant" }>;

// Float16Array isn't in our TypeScript lib and isn't guaranteed at runtime, so we read it off
// globalThis and fall back to a manual half<->float conversion when it's missing.
interface Float16ArrayLike {
    readonly length: number;
    [index: number]: number;
    readonly buffer: ArrayBufferLike;
    readonly byteOffset: number;
    readonly byteLength: number;
}
interface Float16ArrayConstructor {
    new(length: number): Float16ArrayLike;
    new(elements: ArrayLike<number>): Float16ArrayLike;
    new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Float16ArrayLike;
}
const Float16ArrayCtor = (globalThis as { Float16Array?: Float16ArrayConstructor }).Float16Array;

const f32Scratch = new Float32Array(1);
const i32Scratch = new Int32Array(f32Scratch.buffer);
function floatToHalf(value: number): number {
    f32Scratch[0] = value;
    let bitsIn = i32Scratch[0];
    let bits = (bitsIn >> 16) & 0x8000;
    let mantissa = (bitsIn >> 12) & 0x07ff;
    let exponent = (bitsIn >> 23) & 0xff;
    if (exponent < 103) return bits;
    if (exponent > 142) {
        bits |= 0x7c00;
        if (exponent !== 255) {
            bits |= (bitsIn & 0x007fffff);
        }
        return bits;
    }
    if (exponent < 113) {
        mantissa |= 0x0800;
        bits |= (mantissa >> (114 - exponent)) + ((mantissa >> (113 - exponent)) & 1);
        return bits;
    }
    bits |= ((exponent - 112) << 10) | (mantissa >> 1);
    bits += mantissa & 1;
    return bits;
}
function halfToFloat(half: number): number {
    let sign = (half & 0x8000) >> 15;
    let exponent = (half & 0x7c00) >> 10;
    let fraction = half & 0x03ff;
    let signMultiplier = sign && -1 || 1;
    if (exponent === 0) {
        return signMultiplier * Math.pow(2, -14) * (fraction / 1024);
    }
    if (exponent === 0x1f) {
        if (fraction) return NaN;
        return signMultiplier * Infinity;
    }
    return signMultiplier * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function asInt8(bytes: Uint8Array): Int8Array {
    return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function encodeFloat16(values: Float32Array): Uint8Array {
    if (Float16ArrayCtor) {
        let half = new Float16ArrayCtor(values);
        return new Uint8Array(half.buffer, half.byteOffset, half.byteLength);
    }
    let out = new Uint8Array(values.length * 2);
    let view = new DataView(out.buffer);
    for (let index = 0; index < values.length; index++) {
        view.setUint16(index * 2, floatToHalf(values[index]), true);
    }
    return out;
}
function asFloat16Indexable(bytes: Uint8Array): { readonly length: number;[index: number]: number } {
    // Float16Array / Uint16Array views require 2-byte alignment; copy when the stored bytes aren't.
    if (bytes.byteOffset % 2 !== 0) {
        bytes = new Uint8Array(bytes);
    }
    let count = Math.floor(bytes.byteLength / 2);
    if (Float16ArrayCtor) {
        return new Float16ArrayCtor(bytes.buffer, bytes.byteOffset, count);
    }
    let halves = new Uint16Array(bytes.buffer, bytes.byteOffset, count);
    let out = new Float32Array(count);
    for (let index = 0; index < count; index++) {
        out[index] = halfToFloat(halves[index]);
    }
    return out;
}

export function embeddingLength(input: Float32Array | StoredEmbedding): number {
    if (input instanceof Float32Array) return input.length;
    if (input.kind === "float32") return input.values.length;
    return input.data.length;
}

// A pool of reusable Float32 buffers keyed by length. Most embeddings share a size, so internal hot paths
// borrow a buffer (embeddingToFloat32 with usePool) and return it (releaseFloat32) to avoid per-op
// allocations and GC thrashing. A borrowed buffer holds stale data; whoever borrows it overwrites it fully.
//
// Each free buffer records when it was last released; an hourly sweep drops any that have sat idle for over
// an hour, so the runtime can free buffers a burst of work allocated but isn't actually reusing anymore.
const POOL_MAX_IDLE_MS = 60 * 60 * 1000;
type PooledFloat32 = { buffer: Float32Array; releasedAt: number };
const float32Pool = new Map<number, PooledFloat32[]>();
function acquireFloat32(length: number): Float32Array {
    let free = float32Pool.get(length);
    if (free && free.length) {
        return free.pop()!.buffer;
    }
    return new Float32Array(length);
}
export function releaseFloat32(buffer: Float32Array): void {
    let free = float32Pool.get(buffer.length);
    if (!free) {
        free = [];
        float32Pool.set(buffer.length, free);
    }
    free.push({ buffer, releasedAt: Date.now() });
}
function sweepFloat32Pool(): void {
    let cutoff = Date.now() - POOL_MAX_IDLE_MS;
    for (let free of float32Pool.values()) {
        let writeIndex = 0;
        for (let readIndex = 0; readIndex < free.length; readIndex++) {
            if (free[readIndex].releasedAt > cutoff) {
                free[writeIndex++] = free[readIndex];
            }
        }
        free.length = writeIndex;
    }
}
const poolSweepTimer = setInterval(sweepFloat32Pool, POOL_MAX_IDLE_MS) as unknown as { unref?: () => void };
if (typeof poolSweepTimer.unref === "function") {
    poolSweepTimer.unref();
}

// Decode to a Float32Array (full length). Stored values are already unit-normalized (encodeEmbedding does
// that), so this only de-quantizes. By default it allocates a fresh array (a float input is returned as-is,
// no copy). With usePool it borrows a pooled buffer the caller must releaseFloat32 — used by hot internal
// paths so repeated decodes don't allocate.
export function embeddingToFloat32(input: Float32Array | StoredEmbedding, usePool = false): Float32Array {
    if (input instanceof Float32Array) {
        if (!usePool) return input;
        let out = acquireFloat32(input.length);
        out.set(input);
        return out;
    }
    if (input.kind === "float32") {
        if (!usePool) return input.values;
        let out = acquireFloat32(input.values.length);
        out.set(input.values);
        return out;
    }
    let int8 = asInt8(input.data);
    let scales = asFloat16Indexable(input.scales);
    let groupSize = input.groupSize;
    let length = int8.length;
    let out = usePool ? acquireFloat32(length) : new Float32Array(length);
    let group = 0;
    for (let start = 0; start < length; start += groupSize) {
        let scale = scales[group++];
        let end = Math.min(start + groupSize, length);
        for (let index = start; index < end; index++) {
            out[index] = int8[index] * scale;
        }
    }
    return out;
}

// Returns a closure giving the value at a dimension for this embedding's specific type. Lets a generic loop
// compare any two formats without materializing a float array.
export function embeddingAccessor(input: Float32Array | StoredEmbedding): (index: number) => number {
    if (input instanceof Float32Array) {
        return index => input[index];
    }
    if (input.kind === "float32") {
        let values = input.values;
        return index => values[index];
    }
    let int8 = asInt8(input.data);
    let scales = asFloat16Indexable(input.scales);
    let groupSize = input.groupSize;
    return index => int8[index] * scales[(index / groupSize) | 0];
}

function closenessFromDot(dot: number): number {
    // Inputs are unit vectors, so euclidean^2 = 2 - 2*dot; clamp away tiny negatives from float error.
    return 1 - Math.sqrt(Math.max(0, 2 - 2 * dot));
}

function dotFloat32(a: Float32Array, b: Float32Array): number {
    let length = Math.min(a.length, b.length);
    let dot = 0;
    for (let index = 0; index < length; index++) {
        dot += a[index] * b[index];
    }
    return dot;
}

// --- three closeness strategies, kept separate so embeddingBench can race them ---

// Decode both to pooled float32 buffers, dot, return them. No allocation in steady state.
export function closenessByDecode(a: Float32Array | StoredEmbedding, b: Float32Array | StoredEmbedding): number {
    let va = embeddingToFloat32(a, true);
    let vb = embeddingToFloat32(b, true);
    let result = closenessFromDot(dotFloat32(va, vb));
    releaseFloat32(va);
    releaseFloat32(vb);
    return result;
}

// Generic: a value-at-index closure per side, iterate. No allocation, but a function call per dimension.
export function closenessByAccessor(a: Float32Array | StoredEmbedding, b: Float32Array | StoredEmbedding): number {
    let getA = embeddingAccessor(a);
    let getB = embeddingAccessor(b);
    let length = Math.min(embeddingLength(a), embeddingLength(b));
    let dot = 0;
    for (let index = 0; index < length; index++) {
        dot += getA(index) * getB(index);
    }
    return closenessFromDot(dot);
}

// Hard-coded: when both are same-group quant, dot straight from int8 + scales (no float, no closures).
export function closenessByType(a: Float32Array | StoredEmbedding, b: Float32Array | StoredEmbedding): number {
    if (!(a instanceof Float32Array) && !(b instanceof Float32Array) && a.kind === "quant" && b.kind === "quant" && a.groupSize === b.groupSize) {
        let aInt8 = asInt8(a.data);
        let bInt8 = asInt8(b.data);
        let aScales = asFloat16Indexable(a.scales);
        let bScales = asFloat16Indexable(b.scales);
        let length = Math.min(aInt8.length, bInt8.length);
        let groupSize = a.groupSize;
        let dot = 0;
        for (let start = 0; start < length; start += groupSize) {
            let end = Math.min(start + groupSize, length);
            let groupSum = 0;
            for (let index = start; index < end; index++) {
                groupSum += aInt8[index] * bInt8[index];
            }
            dot += groupSum * aScales[start / groupSize] * bScales[start / groupSize];
        }
        return closenessFromDot(dot);
    }
    return closenessByDecode(a, b);
}

// Production closeness. (Set to the embeddingBench winner.)
export const getCloseness = measureWrap(closenessByType);

// Encode a vector (or re-encode an embedding) into the requested format. This is THE place we normalize:
// the (truncated) vector is made unit length here, so anything that's been encoded is reliably normalized
// and the comparison/decoding paths never have to re-normalize.
export function encodeEmbedding(config: {
    input: Float32Array | StoredEmbedding;
    format: EmbeddingFormat;
    model: string;
}): StoredEmbedding {
    let { input, format, model } = config;
    let formatConfig = FORMAT_CONFIGS[format];
    let decoded = embeddingToFloat32(input, true);
    let length = decoded.length;
    if (formatConfig.truncation !== undefined && formatConfig.truncation < length) {
        length = formatConfig.truncation;
    }
    let norm = 0;
    for (let index = 0; index < length; index++) {
        norm += decoded[index] * decoded[index];
    }
    let magnitude = Math.sqrt(norm) || 1;
    for (let index = 0; index < length; index++) {
        decoded[index] /= magnitude;
    }

    let result: StoredEmbedding;
    if (!formatConfig.quant) {
        result = { kind: "float32", model, values: new Float32Array(decoded.subarray(0, length)) };
    } else {
        let { type, groupSize } = formatConfig.quant;
        let groupCount = Math.ceil(length / groupSize);
        let int8 = new Int8Array(length);
        let scales = new Float32Array(groupCount);
        for (let group = 0; group < groupCount; group++) {
            let start = group * groupSize;
            let end = Math.min(start + groupSize, length);
            let maxAbs = 0;
            for (let index = start; index < end; index++) {
                let absValue = Math.abs(decoded[index]);
                if (absValue > maxAbs) maxAbs = absValue;
            }
            let scale = maxAbs / INT8_MAX;
            scales[group] = scale;
            if (!scale) continue;
            for (let index = start; index < end; index++) {
                let quantized = Math.round(decoded[index] / scale);
                if (quantized > INT8_MAX) quantized = INT8_MAX;
                if (quantized < -INT8_MAX) quantized = -INT8_MAX;
                int8[index] = quantized;
            }
        }
        result = {
            kind: "quant",
            model,
            type,
            groupSize,
            data: new Uint8Array(int8.buffer, int8.byteOffset, int8.byteLength),
            scales: encodeFloat16(scales),
        };
    }
    releaseFloat32(decoded);
    return result;
}

type SerializedHeader =
    | { kind: "float32"; model: string }
    | { kind: "quant"; model: string; type: QuantType; groupSize: number; dataBytes: number };

// Serialize to base64 so a StoredEmbedding can travel through the (string) API call result. Layout:
// [4-byte little-endian header length][JSON header][raw typed-array payload(s)].
export function serializeStoredEmbedding(stored: StoredEmbedding): string {
    let header: SerializedHeader;
    let payload: Uint8Array[];
    if (stored.kind === "float32") {
        header = { kind: "float32", model: stored.model };
        payload = [new Uint8Array(stored.values.buffer, stored.values.byteOffset, stored.values.byteLength)];
    } else {
        header = { kind: "quant", model: stored.model, type: stored.type, groupSize: stored.groupSize, dataBytes: stored.data.byteLength };
        payload = [stored.data, stored.scales];
    }
    let headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    let headerLength = Buffer.alloc(4);
    headerLength.writeUInt32LE(headerBytes.length, 0);
    return Buffer.concat([headerLength, headerBytes, ...payload.map(asBuffer)]).toString("base64");
}
export function deserializeStoredEmbedding(base64: string): StoredEmbedding {
    let buffer = Buffer.from(base64, "base64");
    if (buffer.length < 4) {
        throw new Error(`Serialized embedding is too short (${buffer.length} bytes): ${base64.slice(0, 200)}`);
    }
    let headerLength = buffer.readUInt32LE(0);
    let headerEnd = 4 + headerLength;
    if (headerLength <= 0 || headerEnd > buffer.length) {
        throw new Error(`Serialized embedding header length ${headerLength} is invalid for ${buffer.length} bytes: ${base64.slice(0, 200)}`);
    }
    let header = JSON.parse(buffer.toString("utf8", 4, headerEnd)) as SerializedHeader;
    let payload = buffer.subarray(headerEnd);
    if (header.kind === "float32") {
        return { kind: "float32", model: header.model, values: asFloat32(asBuffer(Uint8Array.from(payload))) };
    }
    return {
        kind: "quant",
        model: header.model,
        type: header.type,
        groupSize: header.groupSize,
        data: Uint8Array.from(payload.subarray(0, header.dataBytes)),
        scales: Uint8Array.from(payload.subarray(header.dataBytes)),
    };
}

// Mean of several embeddings (encodeEmbedding normalizes the result to a unit centroid). Borrows a pooled
// accumulator.
export function averageEmbeddings(embeddings: StoredEmbedding[], config: { format: EmbeddingFormat; model: string }): StoredEmbedding {
    let length = Infinity;
    for (let embedding of embeddings) {
        length = Math.min(length, embeddingLength(embedding));
    }
    let sum = acquireFloat32(length);
    sum.fill(0);
    for (let embedding of embeddings) {
        let get = embeddingAccessor(embedding);
        for (let dimension = 0; dimension < length; dimension++) {
            sum[dimension] += get(dimension);
        }
    }
    let result = encodeEmbedding({ input: sum.subarray(0, length), format: config.format, model: config.model });
    releaseFloat32(sum);
    return result;
}

// A stable 16-byte (base64) content hash of an embedding's values, for use as a cell id derived from its
// centroid. Iterates via the accessor (the value bits are hashed, so any format hashes consistently).
export function hashEmbedding(stored: StoredEmbedding): string {
    let get = embeddingAccessor(stored);
    let length = embeddingLength(stored);
    let lanes = new Uint32Array([2166136261, 2654435761, 40503, 3266489917]);
    for (let index = 0; index < length; index++) {
        f32Scratch[0] = get(index);
        let bits = i32Scratch[0];
        for (let lane = 0; lane < lanes.length; lane++) {
            lanes[lane] = Math.imul(lanes[lane] ^ (bits + lane * 131 + index), 16777619);
        }
    }
    return Buffer.from(lanes.buffer).toString("base64");
}
