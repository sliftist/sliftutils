import { PromiseObj, sort, throttleFunction } from "socket-function/src/misc";
import { IStorage, IStorageRaw } from "./IStorage";
import { Zip } from "../misc/zip";
import { runInSerial } from "socket-function/src/batching";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { setPending } from "./PendingManager";
import { isInBuild } from "../misc/environment";

/*
// Spec:
//      - Zip individual large values
//      - Stores a transaction log
//          - Transaction log has a header, which is JSON, for things such as "zipped"
//          - Transaction log uses length prefixed values, with a special 8 bytes to denote the end,
//              and 8 for the start.
//          - When transaction log is iterated on, if the bytes at the end (using the length prefix)
//              don't match the end bytes OR the start bytes are wrong, we skip the start bytes,
//              and iterating until we find new start bytes that match our special bytes. Then we try
//              to read these values.
//          - Each transaction entry has a byte for flags, one bit which denotes if the value is zipped or not.
//      - Compresses the log after there are 3X entries than keys (and > 100)
//          - Both dedupe keys, and zip
//      - Assumes all files in rawStorage ending with .tx are transaction logs
//      - Names files like `${generation}.tx`
//          - When compressing, we increment the generation, and write to a new file, and delete
//              any generations that are older than the new one
//          - On reading, we read from all generation files that exist, in case some are corrupted
//      - On load, loads in all transaction logs, and stores all values in a Map<string, Buffer>
//      - On writes immediately updates the in memory Map, and then writes to the transaction log
//      - Caches the last transaction file name in memory
//      - Makes sure all file system writes (but not Map updates) are done with fileLockSection,
//          so they never overlap.
//      - Buffers pending appends in memory, so they can written all at once (after the first one
//          is blocking in fileLockSection).

UPDATE now we use chunks, because append is too slow.

IMPORTANT! If there are multiple writers, we clobber writes from other writers when we compress
*/


const FILE_CHUNK_SIZE = 1024 * 1024;

const FILE_ZIP_THRESHOLD = 16 * 1024 * 1024;

const ZIP_THRESHOLD = 4096;
const START_BYTES = Buffer.from([236, 49, 112, 121, 27, 127, 227, 63]);
const END_BYTES = Buffer.from([220, 111, 243, 202, 200, 79, 213, 63]);
// Delay writes, so we batch better, and thrash the disk less
const WRITE_DELAY = 500;

interface TransactionEntry {
    key: string;
    value: Buffer | undefined;
    isZipped: boolean;
    time: number;
}

interface TransactionHeader {
    zipped: boolean;
}

const fileLockSection = runInSerial(async (fnc: () => Promise<void>) => {
    await fnc();
});

const CHUNK_EXT = ".chunk";
const ourId = Date.now() + Math.random();

export class TransactionStorage implements IStorage<Buffer> {
    public cache: Map<string, TransactionEntry> = new Map();
    private currentChunk = 0;
    private currentChunkSize = 0;
    private entryCount = 0;

    private static allStorage: TransactionStorage[] = [];

    constructor(
        private rawStorage: IStorageRaw,
        private debugName: string,
        private writeDelay = WRITE_DELAY
    ) {
        TransactionStorage.allStorage.push(this);
    }
    // Helps get rid of parse errors which constantly log. Also, uses less space
    public static async compressAll() {
        for (let storage of TransactionStorage.allStorage) {
            await storage.compressTransactionLog(true);
        }
    }

    private init: Promise<void> | undefined = this.loadAllTransactions();

    private getChunk(chunk: number) { return `${chunk}_${ourId}${CHUNK_EXT}`; }

    public async get(key: string): Promise<Buffer | undefined> {
        await this.init;
        const value = this.cache.get(key);
        if (value && value.isZipped && value.value) {
            value.value = await Zip.gunzip(value.value);
            value.isZipped = false;
        }
        return value?.value;
    }

    public async set(key: string, value: Buffer): Promise<void> {
        if (this.init) await this.init;

        // Time is set on disk write, as Date.now() is too slow
        let entry: TransactionEntry = { key, value, isZipped: false, time: 0 };
        this.cache.set(key, entry);

        if (value.length >= ZIP_THRESHOLD) {
            value = await Zip.gzip(value);
            entry.value = value;
            entry.isZipped = true;
        }
        await this.pushAppend(entry);
    }

    public async remove(key: string): Promise<void> {
        if (this.init) await this.init;
        this.cache.delete(key);

        await this.pushAppend({ key, value: undefined, isZipped: false, time: 0 });
    }

    public async getInfo(key: string): Promise<{ size: number; lastModified: number } | undefined> {
        await this.init;
        const value = this.cache.get(key);
        if (!value?.value) return undefined;
        return { size: value.value.length, lastModified: value.time };
    }

    private pendingAppends: TransactionEntry[] = [];
    private extraAppends = 0;
    private pendingWrite: Promise<void> | undefined;
    async pushAppend(entry: TransactionEntry): Promise<void> {
        this.entryCount++;
        this.pendingAppends.push(entry);
        void this.updatePendingAppends();
        if (this.pendingWrite) return this.pendingWrite;
        this.pendingWrite = fileLockSection(async () => {
            // Delay to allow batching, and deduping
            await new Promise(resolve => setTimeout(resolve, this.writeDelay));
            let curAppends = this.pendingAppends;
            this.pendingAppends = [];
            this.pendingWrite = undefined;
            {
                let appendsDeduped: Map<string, TransactionEntry> = new Map();
                for (const entry of curAppends) {
                    appendsDeduped.set(entry.key, entry);
                }
                curAppends = Array.from(appendsDeduped.values());
            }
            this.extraAppends += curAppends.length;
            void this.updatePendingAppends();
            if (curAppends.length === 0) return;
            try {

                let time = Date.now();
                for (let entry of curAppends) {
                    entry.time = time;
                }

                let newSum = 0;
                let buffers: Buffer[] = [];
                for (const entry of curAppends) {
                    let buffer = this.serializeTransactionEntry(entry);
                    buffers.push(buffer);
                    newSum += buffer.length;
                }

                let newChunks = this.chunkBuffers(buffers);
                for (let chunk of newChunks) {
                    let file = this.getChunk(this.currentChunk);
                    if (!await this.rawStorage.get(file)) {
                        let { header, headerBuffer } = this.getHeader(false);
                        await this.rawStorage.set(file, headerBuffer);
                    }
                    let content = chunk.buffer;
                    await this.rawStorage.append(file, content);
                    this.currentChunkSize += content.length;
                    if (this.currentChunkSize >= FILE_CHUNK_SIZE) {
                        this.currentChunk++;
                        this.currentChunkSize = 0;
                    }
                }

                await this.compressTransactionLog();
            } finally {
                this.extraAppends -= curAppends.length;
                void this.updatePendingAppends();
            }
        });
        await this.pendingWrite;
    }

    private updatePendingAppends = throttleFunction(100, async () => {
        let appendCount = this.pendingAppends.length + this.extraAppends;
        let group = `Transaction (${this.debugName})`;
        //console.log(`Update pending appends ${group}: ${appendCount}`);
        if (!appendCount) {
            setPending(group, "");
            return;
        }
        setPending(group, `Pending appends: ${appendCount}`);
    });

    public async getKeys(): Promise<string[]> {
        if (this.init) await this.init;
        return Array.from(this.cache.keys());
    }


    private async loadAllTransactions(): Promise<void> {
        if (isInBuild()) return;
        let time = Date.now();
        const keys = await this.rawStorage.getKeys();
        const transactionFiles = keys.filter(key => key.endsWith(CHUNK_EXT));

        sort(transactionFiles, x => parseInt(x));

        let size = 0;
        for (const file of transactionFiles) {
            let chunk = parseInt(file);
            let curSize = await this.loadTransactionFile(file);
            if (chunk >= this.currentChunk) {
                this.currentChunk = chunk;
                this.currentChunkSize = curSize;
            }
            size += curSize;
        }
        time = Date.now() - time;
        if (time > 50) {
            console.log(`Loaded ${this.debugName} in ${formatTime(time)}, ${formatNumber(this.cache.size)} keys, ${formatNumber(size)}B`);
        }

        this.init = undefined;
    }

    private async loadTransactionFile(filename: string): Promise<number> {
        const fullFile = await this.rawStorage.get(filename);
        if (!fullFile) return 0;
        if (fullFile.length < 4) {
            //console.error(`Transaction in ${this.debugName} file ${filename} is too small, skipping`);
            return 0;
        }
        let headerSize = fullFile.readUInt32LE(0);
        let headerBuffer = fullFile.slice(4, 4 + headerSize);
        let header: TransactionHeader;
        try {
            header = JSON.parse(headerBuffer.toString());
        } catch (e) {
            console.error(`Failed to parse header of transaction file in ${this.debugName}, ${filename}`);
            return 0;
        }
        let content = fullFile.slice(4 + headerSize);
        if (header.zipped) {
            content = await Zip.gunzip(content);
        }

        let offset = 0;
        let entries: TransactionEntry[] = [];
        while (offset < content.length) {
            if (!content.slice(offset, offset + START_BYTES.length).equals(START_BYTES)) {
                let s = offset;
                while (offset < content.length && !content.slice(offset, offset + START_BYTES.length).equals(START_BYTES)) {
                    offset++;
                }
                let len = offset - s;
                console.warn(`Found bad bytes in ${filename}, skipping ${len} bytes at offset ${s}. Total file bytes ${content.length}, read ${entries.length} entries`);
                if (offset >= content.length) break;
            }
            let entryObj: { entry: TransactionEntry, offset: number } | undefined;
            try {
                entryObj = this.readTransactionEntry(content, offset);
            } catch (e: any) {
                if (e.message.includes("Read past end of buffer")) {
                    offset += 1;
                    continue;
                }
                throw e;
            }
            if (!entryObj) {
                console.warn(`Failed to read transaction entry in in ${this.debugName}, file ${filename} at offset ${offset}, skipping bad bytes, reading remainder of file`);
                offset++;
                continue;
            }
            this.entryCount++;
            let { entry } = entryObj;
            offset = entryObj.offset;
            entries.push(entry);

            if (entry.value === undefined) {
                this.cache.delete(entry.key);
            } else {
                let prev = this.cache.get(entry.key);
                if (prev && (prev.time > entry.time)) {
                    continue;
                }
                this.cache.set(entry.key, entry);
            }
        }
        return fullFile.length;
    }

    private readTransactionEntry(buffer: Buffer, offset: number): {
        entry: TransactionEntry;
        offset: number;
    } | undefined {
        function readSlice(count: number) {
            const slice = buffer.slice(offset, offset + count);
            if (slice.length < count) throw new Error(`Read past end of buffer at offset ${offset}/${buffer.length}`);
            offset += count;
            return slice;
        }
        if (!readSlice(START_BYTES.length).equals(START_BYTES)) return undefined;

        const keyLength = readSlice(4).readUInt32LE(0);
        const valueLength = readSlice(4).readUInt32LE(0);
        const time = readSlice(8).readDoubleLE(0);
        const flags = readSlice(1).readUInt8(0);

        const key = readSlice(keyLength).toString();
        let value = readSlice(valueLength);

        if (!readSlice(END_BYTES.length).equals(END_BYTES)) return undefined;

        let isZipped = (flags & 1) === 1;
        let isDelete = (flags & 2) === 2;

        let entry: TransactionEntry = { key, value, isZipped, time };
        if (isDelete) {
            entry.value = undefined;
        }
        return { entry, offset };
    }

    // TODO: Make this directly go from TransactionEntry[] to Buffer, by pre-allocating, so it is more efficient
    private serializeTransactionEntry(entry: TransactionEntry): Buffer {
        let keyBuffer = Buffer.from(entry.key);
        const buffer = Buffer.alloc(
            START_BYTES.length + 4 + 4 + 8 + 1 + keyBuffer.length + (entry.value?.length || 0) + END_BYTES.length
        );
        let offset = 0;

        START_BYTES.copy(buffer, offset);
        offset += START_BYTES.length;

        buffer.writeUInt32LE(keyBuffer.length, offset);
        offset += 4;

        buffer.writeUInt32LE(entry.value ? entry.value.length : 0, offset);
        offset += 4;

        buffer.writeDoubleLE(entry.time, offset);
        offset += 8;

        let flags = 0;
        if (entry.isZipped) flags |= 1;
        if (entry.value === undefined) flags |= 2;
        buffer.writeUInt8(flags, offset);
        offset += 1;

        keyBuffer.copy(buffer, offset);
        offset += keyBuffer.length;

        if (entry.value) {
            entry.value.copy(buffer, offset);
            offset += entry.value.length;
        }

        END_BYTES.copy(buffer, offset);
        offset += END_BYTES.length;

        return buffer;
    }

    private getHeader(zip: boolean) {
        const header: TransactionHeader = { zipped: zip };
        let headerBuffer = Buffer.from(JSON.stringify(header));
        let headerSize = Buffer.alloc(4);
        headerSize.writeUInt32LE(headerBuffer.length, 0);
        return { header, headerBuffer: Buffer.concat([headerSize, headerBuffer]) };
    }

    private chunkBuffers(buffers: Buffer[]) {
        let newChunks: {
            buffers: Buffer[];
            size: number;
        }[] = [];
        newChunks.push({ buffers: [], size: 0 });
        for (const buffer of buffers) {
            if (newChunks[newChunks.length - 1].size + buffer.length >= FILE_CHUNK_SIZE) {
                newChunks.push({ buffers: [], size: 0 });
            }
            newChunks[newChunks.length - 1].buffers.push(buffer);
            newChunks[newChunks.length - 1].size += buffer.length;
        }
        return newChunks.map(x => ({ buffer: Buffer.concat(x.buffers), size: x.size }));
    }


    private compressing = false;
    private async compressTransactionLog(force?: boolean): Promise<void> {
        if (this.compressing) return;
        this.compressing = true;

        let existingDiskEntries = await this.rawStorage.getKeys();
        existingDiskEntries = existingDiskEntries.filter(x => x.endsWith(CHUNK_EXT));
        let compressNow = force || (
            this.entryCount > 100 && this.entryCount > this.cache.size * 3
            // NOTE: This compress check breaks down if we only have very large values, but... those
            //  don't work ANYWAYS (it is better to use one file per value instead).
            //  - Maybe we should throw, or at least warn, on sets of value > 1MB,
            //      at which point they should just use a file per value
            || existingDiskEntries.length > Math.max(10, Math.ceil(this.entryCount / 1000))
            || existingDiskEntries.length > 1000 * 10
        );
        if (!compressNow) return;
        console.log(`Compressing ${this.debugName} transaction log, ${this.entryCount} entries, ${this.cache.size} keys`);

        // Load off disk, in case there are other writes. We still race with them, but at least
        //  this reduces the race condition considerably

        sort(existingDiskEntries, x => parseInt(x));
        for (let entry of existingDiskEntries) {
            await this.loadTransactionFile(entry);
        }

        this.entryCount = this.cache.size;

        let nextStart = Math.max(...existingDiskEntries.map(x => parseInt(x))) + 1;

        let buffers: Buffer[] = [];
        for (const entry of this.cache.values()) {
            let buffer = this.serializeTransactionEntry(entry);
            buffers.push(buffer);
        }

        let newChunks = this.chunkBuffers(buffers);

        let curChunk = nextStart;
        for (let chunk of newChunks) {
            let file = this.getChunk(curChunk++);
            let content = chunk.buffer;
            let { header, headerBuffer } = this.getHeader(
                // AND, never compress the last one, otherwise we can't append to it!
                content.length >= FILE_ZIP_THRESHOLD && chunk !== newChunks[newChunks.length - 1]
            );
            if (header.zipped) {
                content = await Zip.gzip(content);
            }
            let buffer = Buffer.concat([headerBuffer, content]);
            await this.rawStorage.set(file, buffer);
        }

        // This is the ONLY time we can delete old files, as we know for sure the new file has all of our data.
        //  Any future readers won't know this, unless they write it themselves (or unless they audit it against
        //      the other generations, which is annoying).
        for (const file of existingDiskEntries) {
            await this.rawStorage.remove(file);
        }

        this.currentChunk = curChunk;
    }

    public async reset() {
        await fileLockSection(async () => {
            let existingDiskEntries = await this.rawStorage.getKeys();
            existingDiskEntries = existingDiskEntries.filter(x => x.endsWith(CHUNK_EXT));

            try {
                await Promise.allSettled(existingDiskEntries.map(x => this.rawStorage.remove(x)));
            } catch { }

            this.pendingAppends = [];
            this.cache.clear();
            this.currentChunk = 0;
            this.currentChunkSize = 0;
            this.entryCount = 0;
        });
    }
}