import { LZ4 } from "socket-function/src/lz4/LZ4";

// Block-aligned, promise-deduped, decompressing range cache for BulkDatabase2's on-disk files.
// 
// On-disk format (produced by encodeCompressedBlocks): the logical (uncompressed) bulk buffer is split into fixed BLOCK_SIZE blocks; each block is LZ4-compressed unless that wouldn't shrink it by at least 2x, in which case it's stored raw. The file starts with a JSON index mapping each block to its stored length + a compressed flag, so a reader can seek straight to any block:
// 
//   [u32 indexLength][index JSON][block 0 stored bytes][block 1 stored bytes]...
// 
// The cache presents a *logical* getRange (over uncompressed bytes) so BulkDatabase2's reader is oblivious to compression. It reads compressed bytes via the underlying getRange, decompresses, and caches the uncompressed blocks. Reads are promise-deduped and contiguous missing blocks are coalesced into one underlying read. Files are immutable, so cached blocks are valid forever.
// 
// Per-block compression mainly helps slow storage (HDD): fewer bytes off disk per block, at the cost of a fast in-memory LZ4 decompress.

const BLOCK_SIZE = 256 * 1024;
const MAX_BLOCKS = Math.floor((512 * 1024 * 1024) / BLOCK_SIZE);
const MIN_COMPRESSION_RATIO = 2;

const EMPTY = Buffer.alloc(0) as Buffer;

export type GetRange = (start: number, end: number) => Promise<Buffer>;

type BlockMeta = { len: number; c: 0 | 1 };
type FileIndex = {
    uncompressedSize: number;
    blockSize: number;
    blocks: BlockMeta[];
    // Stored byte offset of each block (offsets[i]..offsets[i]+blocks[i].len), filled in on parse.
    offsets: number[];
};

// Writes a logical bulk buffer in the compressed-block format described above.
export function encodeCompressedBlocks(data: Buffer): Buffer {
    let blocks: BlockMeta[] = [];
    let storedParts: Buffer[] = [];
    let blockCount = Math.ceil(data.length / BLOCK_SIZE);
    for (let i = 0; i < blockCount; i++) {
        let raw = data.subarray(i * BLOCK_SIZE, Math.min((i + 1) * BLOCK_SIZE, data.length));
        let compressed = LZ4.compress(raw);
        // Only keep the compressed form if it shrinks the block by at least MIN_COMPRESSION_RATIO.
        if (compressed.length * MIN_COMPRESSION_RATIO <= raw.length) {
            storedParts.push(compressed);
            blocks.push({ len: compressed.length, c: 1 });
        } else {
            storedParts.push(raw);
            blocks.push({ len: raw.length, c: 0 });
        }
    }
    let indexBuf = Buffer.from(JSON.stringify({ uncompressedSize: data.length, blockSize: BLOCK_SIZE, blocks }), "utf8");
    let prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(indexBuf.length, 0);
    return Buffer.concat([prefix, indexBuf, ...storedParts]);
}

export class BlockCache {
    // Uncompressed blocks; insertion order is LRU order (re-inserted on access).
    private blocks = new Map<string, Promise<Buffer>>();
    // Parsed file index per fileId (small; not subject to the block LRU).
    private indexes = new Map<string, Promise<FileIndex>>();

    public clear() {
        this.blocks.clear();
        this.indexes.clear();
    }

    public evict(fileId: string) {
        this.indexes.delete(fileId);
        const prefix = fileId + ":";
        for (const key of this.blocks.keys()) if (key.startsWith(prefix)) this.blocks.delete(key);
    }

    private touch(key: string, value: Promise<Buffer>) {
        this.blocks.delete(key);
        this.blocks.set(key, value);
        while (this.blocks.size > MAX_BLOCKS) {
            let oldest = this.blocks.keys().next().value;
            if (oldest === undefined) break;
            this.blocks.delete(oldest);
        }
    }

    // Reads + validates the file index. Rejects the WHOLE file if it isn't exactly the size its index implies — a truncated/partial write (e.g. a crash mid-write) is detected here rather than silently returning corrupted values for the rows near the end.
    private async readIndex(rawGetRange: GetRange, fileSize: number): Promise<FileIndex> {
        let head = await rawGetRange(0, 4);
        if (head.length < 4) throw new Error(`bulk file too short for an index header (${fileSize} bytes)`);
        let indexLength = head.readUInt32LE(0);
        if (indexLength <= 0 || 4 + indexLength > fileSize) {
            throw new Error(`bulk file index length ${indexLength} is invalid for a ${fileSize}-byte file`);
        }
        let indexBuf = await rawGetRange(4, 4 + indexLength);
        let parsed = JSON.parse(indexBuf.toString("utf8")) as { uncompressedSize: number; blockSize: number; blocks: BlockMeta[] };
        let dataBase = 4 + indexLength;
        let offsets: number[] = [];
        let offset = dataBase;
        for (let block of parsed.blocks) {
            offsets.push(offset);
            offset += block.len;
        }
        // The blocks must account for exactly the rest of the file. Any mismatch means the file is truncated or otherwise corrupt — reject it entirely.
        if (offset !== fileSize) {
            throw new Error(`bulk file is ${fileSize} bytes but its index implies ${offset} (truncated/corrupt)`);
        }
        return { ...parsed, offsets };
    }

    // Opens an immutable file: reads + validates its index (cached) and returns the logical (uncompressed) size plus a logical getRange that the caller can use exactly like an uncompressed file. `fileSize` is the actual on-disk byte length, used to detect truncation.
    public async open(fileId: string, fileSize: number, rawGetRange: GetRange): Promise<{ uncompressedSize: number; getRange: GetRange }> {
        let indexPromise = this.indexes.get(fileId);
        if (!indexPromise) {
            indexPromise = this.readIndex(rawGetRange, fileSize);
            this.indexes.set(fileId, indexPromise);
        }
        let index = await indexPromise;
        return { uncompressedSize: index.uncompressedSize, getRange: this.makeGetRange(fileId, index, rawGetRange) };
    }

    private makeGetRange(fileId: string, index: FileIndex, rawGetRange: GetRange): GetRange {
        let blockSize = index.blockSize;
        return async (start, end) => {
            if (end <= start) return EMPTY;
            let firstBlock = Math.floor(start / blockSize);
            let lastBlock = Math.floor((end - 1) / blockSize);

            let parts: Buffer[] = [];
            let block = firstBlock;
            while (block <= lastBlock) {
                let key = `${fileId}:${block}`;
                let cached = this.blocks.get(key);
                if (cached) {
                    this.touch(key, cached);
                    parts.push(await cached);
                    block++;
                    continue;
                }
                // Coalesce a run of consecutive missing blocks into one underlying (compressed) read.
                let runStart = block;
                let runEnd = block + 1;
                while (runEnd <= lastBlock && !this.blocks.has(`${fileId}:${runEnd}`)) runEnd++;
                let compStart = index.offsets[runStart];
                let lastMeta = index.blocks[runEnd - 1];
                let compEnd = index.offsets[runEnd - 1] + lastMeta.len;
                let runCompressed = rawGetRange(compStart, compEnd);
                // Hold this run's promises locally. Registering them in the LRU can evict earlier blocks of the same run (or of a concurrent run) before we get to await them, so reading them back out of the cache would silently drop blocks and return a short buffer. We still register in the LRU so concurrent reads dedupe onto them.
                let runPromises: Promise<Buffer>[] = [];
                for (let i = runStart; i < runEnd; i++) {
                    let meta = index.blocks[i];
                    let relOffset = index.offsets[i] - compStart;
                    let blockPromise = runCompressed.then(buf => {
                        let stored = buf.subarray(relOffset, relOffset + meta.len);
                        if (meta.c) return LZ4.decompress(stored);
                        return stored;
                    });
                    runPromises.push(blockPromise);
                    this.touch(`${fileId}:${i}`, blockPromise);
                }
                for (let promise of runPromises) parts.push(await promise);
                block = runEnd;
            }

            let combined = parts.length === 1 && parts[0] || Buffer.concat(parts);
            let sliceStart = start - firstBlock * blockSize;
            // A short combined buffer means we lost blocks; subarray would clamp and hand back truncated data that every caller treats as valid. Fail loudly instead.
            if (combined.length < sliceStart + (end - start)) {
                throw new Error(`Expected ${sliceStart + (end - start)} bytes of blocks for range [${start}, ${end}) of ${fileId}, was ${combined.length}`);
            }
            return combined.subarray(sliceStart, sliceStart + (end - start));
        };
    }
}

// Shared across every BulkDatabase2 collection/file (the 512MB budget is global).
export const blockCache = new BlockCache();
