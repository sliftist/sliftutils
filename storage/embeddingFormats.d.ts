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
export declare function embeddingLength(input: Float32Array | StoredEmbedding): number;
export declare function releaseFloat32(buffer: Float32Array): void;
export declare function embeddingToFloat32(input: Float32Array | StoredEmbedding, usePool?: boolean): Float32Array;
export declare const getCloseness: (a: Float32Array | StoredEmbedding, b: Float32Array | StoredEmbedding) => number;
export declare function encodeEmbedding(config: {
    input: Float32Array | StoredEmbedding;
    format: EmbeddingFormat;
    model: string;
}): StoredEmbedding;
export declare function serializeStoredEmbedding(stored: StoredEmbedding): string;
export declare function deserializeStoredEmbedding(base64: string): StoredEmbedding;
export declare function averageEmbeddings(embeddings: StoredEmbedding[], config: {
    format: EmbeddingFormat;
    model: string;
}): StoredEmbedding;
export declare function hashEmbedding(stored: StoredEmbedding): string;
