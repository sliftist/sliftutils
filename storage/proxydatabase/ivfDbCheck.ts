import fs from "fs";
import { InMemoryDatabase } from "./inMemoryDatabase";
import { IvfEmbeddingRoot, IvfConfig, EmbeddingInput, insertEmbeddings, searchEmbeddings } from "./ivfEmbeddingDatabase";
import { encodeEmbedding, EmbeddingFormat } from "../embeddingFormats";

// Exercises the tiered IVF embedding database through the in-memory Database wrapper, which counts every
// read/write/delete call and the bytes through each, across dataset sizes and load patterns, with timing.

const DIM = 512;
const SRC = "/root/claude-work/face-embeddings/faceFrames2_full.f32";
const MODEL = "buffalo_l";
const FORMAT: EmbeddingFormat = "q8g8_2048";

function loadFloats(count: number): Float32Array {
    const byteLength = count * DIM * 4;
    const buffer = Buffer.alloc(byteLength);
    const handle = fs.openSync(SRC, "r");
    fs.readSync(handle, buffer, 0, byteLength, 0);
    fs.closeSync(handle);
    return new Float32Array(buffer.buffer, buffer.byteOffset, count * DIM);
}

function buildInputs(count: number): EmbeddingInput[] {
    const floats = loadFloats(count);
    const inputs: EmbeddingInput[] = [];
    for (let index = 0; index < count; index++) {
        const slice = floats.subarray(index * DIM, (index + 1) * DIM);
        inputs.push({ ref: "e" + index, embedding: encodeEmbedding({ input: slice, format: FORMAT, model: MODEL }) });
    }
    return inputs;
}

function freshDatabase(config: IvfConfig): InMemoryDatabase<IvfEmbeddingRoot> {
    const root: IvfEmbeddingRoot = { config, count: 0, flat: {}, steps: {}, centroids: {}, cells: {} };
    return new InMemoryDatabase<IvfEmbeddingRoot>(root);
}

function pad(value: string | number, width: number): string {
    return String(value).padStart(width);
}

function main() {
    const config: IvfConfig = { model: MODEL, format: FORMAT, cellTargetSize: 128 };
    const runs: { size: number; batch: number }[] = [
        { size: 10000, batch: 1 },
        { size: 10000, batch: 100 },
        { size: 100000, batch: 1000 },
    ];

    let maxSize = 0;
    for (const run of runs) {
        if (run.size > maxSize) {
            maxSize = run.size;
        }
    }
    const loadStart = Date.now();
    const allInputs = buildInputs(maxSize);
    console.log(`loaded + encoded ${maxSize} embeddings in ${((Date.now() - loadStart) / 1000).toFixed(1)}s\n`);

    console.log(`${pad("added", 7)} ${pad("batch", 5)} | ${pad("secs", 7)} ${pad("reads", 8)} ${pad("writes", 8)} ${pad("deletes", 8)} ${pad("readMB", 9)} ${pad("writeMB", 8)} | recall`);
    for (const run of runs) {
        const database = freshDatabase(config);
        const start = Date.now();
        for (let offset = 0; offset < run.size; offset += run.batch) {
            insertEmbeddings(database, allInputs.slice(offset, offset + run.batch));
        }
        const seconds = (Date.now() - start) / 1000;

        let found = 0;
        const sampleCount = 100;
        for (let index = 0; index < sampleCount; index++) {
            const query = allInputs[Math.floor(index * run.size / sampleCount)];
            const hits = searchEmbeddings(database, query.embedding, { probeBudget: 512, resultCount: 1 });
            if (hits && hits.length && hits[0].ref === query.ref) {
                found++;
            }
        }
        const recall = (found / sampleCount).toFixed(2);
        console.log(`${pad(run.size, 7)} ${pad(run.batch, 5)} | ${pad(seconds.toFixed(1), 7)} ${pad(database.readCalls, 8)} ${pad(database.writeCalls, 8)} ${pad(database.deleteCalls, 8)} ${pad((database.bytesRead / 1e6).toFixed(0), 9)} ${pad((database.bytesWritten / 1e6).toFixed(0), 8)} | ${recall}`);
    }
}

main();
