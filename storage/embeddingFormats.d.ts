export type EmbeddingFormat = "q8g8_2048" | "q8_g16_2048" | "q8_g16_1024" | "float32";
export declare const EMBEDDING_FORMATS: EmbeddingFormat[];
export declare const DEFAULT_EMBEDDING_FORMAT: EmbeddingFormat;
export type QuantType = "q8";
export type StoredEmbedding = {
    kind: "float32";
    model: string;
    values: Float32Array;
} | {
    kind: "quant";
    model: string;
    type: QuantType;
    groupSize: number;
    data: Uint8Array;
    scales: Uint8Array;
};
export declare function encodeEmbedding(config: {
    input: Float32Array | StoredEmbedding;
    format: EmbeddingFormat;
    model: string;
}): StoredEmbedding;
export declare function serializeStoredEmbedding(stored: StoredEmbedding): string;
export declare function deserializeStoredEmbedding(base64: string): StoredEmbedding;
export declare const getCloseness: (embedding1: Float32Array | StoredEmbedding, embedding2: Float32Array | StoredEmbedding) => number;
