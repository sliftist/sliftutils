import fs from "fs";
import { encodeEmbedding, StoredEmbedding, EmbeddingFormat, embeddingToFloat32, closenessByDecode, closenessByType, closenessByAccessor } from "./embeddingFormats";

// Races the closeness strategies (decode-to-float / hard-coded-by-type / generic-accessor) on a k-means-
// shaped workload, to decide which getCloseness should use. The accessor path is simplest; per the rule we
// keep it if it's within 50% of the fastest.

const DIM = 512;
const SRC = "/root/claude-work/face-embeddings/faceEntry2.f32";
const MODEL = "buffalo_l";
const FORMAT: EmbeddingFormat = "q8g8_2048";

function loadEmbeddings(count: number): StoredEmbedding[] {
    const byteLength = count * DIM * 4;
    const buffer = Buffer.alloc(byteLength);
    const handle = fs.openSync(SRC, "r");
    fs.readSync(handle, buffer, 0, byteLength, 0);
    fs.closeSync(handle);
    const floats = new Float32Array(buffer.buffer, buffer.byteOffset, count * DIM);
    const out: StoredEmbedding[] = [];
    for (let index = 0; index < count; index++) {
        out.push(encodeEmbedding({ input: floats.subarray(index * DIM, (index + 1) * DIM), format: FORMAT, model: MODEL }));
    }
    return out;
}

function timeStrategy(
    name: string,
    closeness: (a: StoredEmbedding, b: StoredEmbedding) => number,
    members: StoredEmbedding[],
    centroids: StoredEmbedding[],
    repeats: number,
): number {
    let checksum = 0;
    const start = Date.now();
    for (let repeat = 0; repeat < repeats; repeat++) {
        for (const member of members) {
            for (const centroid of centroids) {
                checksum += closeness(member, centroid);
            }
        }
    }
    const seconds = (Date.now() - start) / 1000;
    const calls = repeats * members.length * centroids.length;
    console.log(`  ${name.padEnd(9)} ${seconds.toFixed(3)}s   ${(calls / seconds / 1e6).toFixed(1)} M/s   (checksum ${checksum.toFixed(0)})`);
    return seconds;
}

// Convert every embedding to a float32 array ONCE, then do plain float dots. This is the batch-friendly
// path (the per-call decode cost amortizes over the whole member x centroid grid).
function timeFloat32Once(members: StoredEmbedding[], centroids: StoredEmbedding[], repeats: number): number {
    let checksum = 0;
    const start = Date.now();
    for (let repeat = 0; repeat < repeats; repeat++) {
        const memberFloats: Float32Array[] = [];
        for (const member of members) {
            memberFloats.push(embeddingToFloat32(member));
        }
        const centroidFloats: Float32Array[] = [];
        for (const centroid of centroids) {
            centroidFloats.push(embeddingToFloat32(centroid));
        }
        for (const memberFloat of memberFloats) {
            for (const centroidFloat of centroidFloats) {
                const length = Math.min(memberFloat.length, centroidFloat.length);
                let dot = 0;
                for (let index = 0; index < length; index++) {
                    dot += memberFloat[index] * centroidFloat[index];
                }
                checksum += 1 - Math.sqrt(Math.max(0, 2 - 2 * dot));
            }
        }
    }
    const seconds = (Date.now() - start) / 1000;
    const calls = repeats * members.length * centroids.length;
    console.log(`  ${"f32-once".padEnd(9)} ${seconds.toFixed(3)}s   ${(calls / seconds / 1e6).toFixed(1)} M/s   (checksum ${checksum.toFixed(0)})`);
    return seconds;
}

function main() {
    const members = loadEmbeddings(2000);
    const centroids = members.slice(0, 100);
    const repeats = 3;
    console.log(`closeness: ${members.length} x ${centroids.length} x ${repeats} = ${(members.length * centroids.length * repeats / 1e6).toFixed(1)}M q8g8 comparisons`);

    // warm up the JIT on a small slice
    timeStrategy("warmup", closenessByType, members.slice(0, 200), centroids, 1);
    console.log("");

    const decode = timeStrategy("decode", closenessByDecode, members, centroids, repeats);
    const byType = timeStrategy("type", closenessByType, members, centroids, repeats);
    const accessor = timeStrategy("accessor", closenessByAccessor, members, centroids, repeats);
    const float32Once = timeFloat32Once(members, centroids, repeats);

    const fastest = Math.min(decode, byType, accessor, float32Once);
    const ratio = accessor / fastest;
    console.log(`\nfastest = ${fastest.toFixed(3)}s; accessor is ${ratio.toFixed(2)}x of it -> ${ratio <= 1.5 ? "accessor OK for getCloseness" : "getCloseness keeps the hard-coded type path"}`);
}

main();
