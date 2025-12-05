/// <reference types="node" />
/// <reference types="node" />
export declare class Zip {
    static gzip(buffer: Buffer, level?: number): Promise<Buffer>;
    static gunzip(buffer: Buffer): Promise<Buffer>;
    static gunzipBatch(buffers: Buffer[]): Promise<Buffer[]>;
}
