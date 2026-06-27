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
    let x = i32Scratch[0];
    let bits = (x >> 16) & 0x8000;
    let m = (x >> 12) & 0x07ff;
    let e = (x >> 23) & 0xff;
    if (e < 103) return bits;
    if (e > 142) {
        bits |= 0x7c00;
        if (e !== 255) {
            bits |= (x & 0x007fffff);
        }
        return bits;
    }
    if (e < 113) {
        m |= 0x0800;
        bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
        return bits;
    }
    bits |= ((e - 112) << 10) | (m >> 1);
    bits += m & 1;
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
    for (let i = 0; i < values.length; i++) {
        view.setUint16(i * 2, floatToHalf(values[i]), true);
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
    for (let i = 0; i < count; i++) {
        out[i] = halfToFloat(halves[i]);
    }
    return out;
}

function normalizeInPlace(vector: Float32Array): Float32Array {
    let sum = 0;
    for (let i = 0; i < vector.length; i++) {
        sum += vector[i] * vector[i];
    }
    let magnitude = Math.sqrt(sum);
    if (!magnitude) return vector;
    for (let i = 0; i < vector.length; i++) {
        vector[i] /= magnitude;
    }
    return vector;
}

function embeddingLength(input: Float32Array | StoredEmbedding): number {
    if (input instanceof Float32Array) return input.length;
    if (input.kind === "float32") return input.values.length;
    return input.data.length;
}

// Decode any accepted input to a fresh, mutable Float32Array of exactly `length` dimensions
// (truncating). Always allocates, so callers can normalize it in place without touching stored data.
function decodeToLength(input: Float32Array | StoredEmbedding, length: number): Float32Array {
    let out = new Float32Array(length);
    if (input instanceof Float32Array) {
        for (let i = 0; i < length; i++) {
            out[i] = input[i];
        }
        return out;
    }
    if (input.kind === "float32") {
        let values = input.values;
        for (let i = 0; i < length; i++) {
            out[i] = values[i];
        }
        return out;
    }
    let int8 = asInt8(input.data);
    let scales = asFloat16Indexable(input.scales);
    let groupSize = input.groupSize;
    for (let i = 0; i < length; i++) {
        out[i] = int8[i] * scales[Math.floor(i / groupSize)];
    }
    return out;
}

// Convert a raw float32 vector (or re-encode an existing StoredEmbedding) into the requested format.
export function encodeEmbedding(config: {
    input: Float32Array | StoredEmbedding;
    format: EmbeddingFormat;
    model: string;
}): StoredEmbedding {
    let { input, format, model } = config;
    let formatConfig = FORMAT_CONFIGS[format];
    let length = embeddingLength(input);
    if (formatConfig.truncation !== undefined) {
        length = Math.min(formatConfig.truncation, length);
    }
    // Truncate to a fresh array, then renormalize so the shortened vector is unit length again.
    let vector = normalizeInPlace(decodeToLength(input, length));

    if (!formatConfig.quant) {
        return { kind: "float32", model, values: vector };
    }
    let { type, groupSize } = formatConfig.quant;
    let groupCount = Math.ceil(length / groupSize);
    let int8 = new Int8Array(length);
    let scales = new Float32Array(groupCount);
    for (let g = 0; g < groupCount; g++) {
        let start = g * groupSize;
        let end = Math.min(start + groupSize, length);
        let maxAbs = 0;
        for (let i = start; i < end; i++) {
            let magnitude = Math.abs(vector[i]);
            if (magnitude > maxAbs) maxAbs = magnitude;
        }
        let scale = maxAbs / INT8_MAX;
        scales[g] = scale;
        if (!scale) continue;
        for (let i = start; i < end; i++) {
            let quantized = Math.round(vector[i] / scale);
            if (quantized > INT8_MAX) quantized = INT8_MAX;
            if (quantized < -INT8_MAX) quantized = -INT8_MAX;
            int8[i] = quantized;
        }
    }
    return {
        kind: "quant",
        model,
        type,
        groupSize,
        data: new Uint8Array(int8.buffer, int8.byteOffset, int8.byteLength),
        scales: encodeFloat16(scales),
    };
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

// Compare two embeddings in any format / truncation. Both are decoded, truncated to their common
// length, and unit-normalized, then scored as 1 minus their euclidean distance.
export const getCloseness = measureWrap(function getCloseness(
    embedding1: Float32Array | StoredEmbedding,
    embedding2: Float32Array | StoredEmbedding,
): number {
    let length = Math.min(embeddingLength(embedding1), embeddingLength(embedding2));
    let vector1 = normalizeInPlace(decodeToLength(embedding1, length));
    let vector2 = normalizeInPlace(decodeToLength(embedding2, length));
    let sum = 0;
    for (let i = 0; i < length; i++) {
        let diff = vector1[i] - vector2[i];
        sum += diff * diff;
    }
    return 1 - Math.sqrt(sum);
});
