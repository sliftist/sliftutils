/// <reference types="node" />
/// <reference types="node" />
export type GetRange = (start: number, end: number) => Promise<Buffer>;
export declare function encodeCompressedBlocks(data: Buffer): Buffer;
export declare class BlockCache {
    private blocks;
    private indexes;
    clear(): void;
    private touch;
    private readIndex;
    open(fileId: string, fileSize: number, rawGetRange: GetRange): Promise<{
        uncompressedSize: number;
        getRange: GetRange;
    }>;
    private makeGetRange;
}
export declare const blockCache: BlockCache;
