import fs from "fs";
import { ensureFaceData } from "./faceFramesData";
import { encodeEmbedding, averageEmbeddings, embeddingToFloat32, releaseFloat32, getCloseness, StoredEmbedding, EmbeddingFormat } from "./embeddingFormats";

// Runs a generic k-means parameterized by an arbitrary getCloseness, so we can race the closeness
// implementations (all exported from embeddingFormats) on a real clustering workload — plus a variant that
// decodes every embedding to float32 once and uses plain float dots. Push + run with: typenode storage/embeddingBench.ts

const DIM = 512;
const FILE_NAME = "faceEntry2.f32";
const MODEL = "buffalo_l";
const FORMAT: EmbeddingFormat = "q8g8_2048";
const CONFIG = { format: FORMAT, model: MODEL };

async function loadEmbeddings(count: number): Promise<StoredEmbedding[]> {
    const byteLength = count * DIM * 4;
    const filePath = await ensureFaceData(FILE_NAME, byteLength);
    const buffer = Buffer.alloc(byteLength);
    const handle = fs.openSync(filePath, "r");
    fs.readSync(handle, buffer, 0, byteLength, 0);
    fs.closeSync(handle);
    const floats = new Float32Array(buffer.buffer, buffer.byteOffset, count * DIM);
    const out: StoredEmbedding[] = [];
    for (let index = 0; index < count; index++) {
        out.push(encodeEmbedding({ input: floats.subarray(index * DIM, (index + 1) * DIM), format: FORMAT, model: MODEL }));
    }
    return out;
}

// Plain k-means: assign each member to the nearest centroid via `closeness`, recompute centroids as the
// (re-encoded) mean. The closeness function is the only thing that varies.
function kmeans(members: StoredEmbedding[], clusterCount: number, iterations: number, closeness: (a: StoredEmbedding, b: StoredEmbedding) => number): number {
    let centroids: StoredEmbedding[] = [];
    const seedStride = members.length / clusterCount;
    for (let index = 0; index < clusterCount; index++) {
        centroids.push(members[Math.floor(index * seedStride)]);
    }
    for (let iteration = 0; iteration < iterations; iteration++) {
        const groups: StoredEmbedding[][] = [];
        for (let index = 0; index < centroids.length; index++) {
            groups.push([]);
        }
        for (const member of members) {
            let bestIndex = 0;
            let bestCloseness = -Infinity;
            for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex++) {
                const value = closeness(member, centroids[centroidIndex]);
                if (value > bestCloseness) {
                    bestCloseness = value;
                    bestIndex = centroidIndex;
                }
            }
            groups[bestIndex].push(member);
        }
        const next: StoredEmbedding[] = [];
        for (const group of groups) {
            if (group.length) {
                next.push(averageEmbeddings(group, CONFIG));
            }
        }
        centroids = next;
    }
    return centroids.length;
}

// The same k-means but every embedding is decoded to a float32 array ONCE up front; centroids stay float
// arrays and assignment is a plain float dot. No per-comparison decode, no centroid re-encode.
function kmeansFloat32Once(members: StoredEmbedding[], clusterCount: number, iterations: number): number {
    const memberFloats: Float32Array[] = [];
    for (const member of members) {
        memberFloats.push(embeddingToFloat32(member, true));
    }
    let centroids: Float32Array[] = [];
    const seedStride = members.length / clusterCount;
    for (let index = 0; index < clusterCount; index++) {
        centroids.push(memberFloats[Math.floor(index * seedStride)]);
    }
    for (let iteration = 0; iteration < iterations; iteration++) {
        const groups: number[][] = [];
        for (let index = 0; index < centroids.length; index++) {
            groups.push([]);
        }
        for (let memberIndex = 0; memberIndex < memberFloats.length; memberIndex++) {
            const memberFloat = memberFloats[memberIndex];
            let bestIndex = 0;
            let bestDot = -Infinity;
            for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex++) {
                const centroidFloat = centroids[centroidIndex];
                const length = Math.min(memberFloat.length, centroidFloat.length);
                let dot = 0;
                for (let dim = 0; dim < length; dim++) {
                    dot += memberFloat[dim] * centroidFloat[dim];
                }
                if (dot > bestDot) {
                    bestDot = dot;
                    bestIndex = centroidIndex;
                }
            }
            groups[bestIndex].push(memberIndex);
        }
        const next: Float32Array[] = [];
        for (const group of groups) {
            if (!group.length) {
                continue;
            }
            const length = memberFloats[group[0]].length;
            const sum = new Float32Array(length);
            for (const memberIndex of group) {
                const memberFloat = memberFloats[memberIndex];
                for (let dim = 0; dim < length; dim++) {
                    sum[dim] += memberFloat[dim];
                }
            }
            let norm = 0;
            for (let dim = 0; dim < length; dim++) {
                norm += sum[dim] * sum[dim];
            }
            const magnitude = Math.sqrt(norm) || 1;
            for (let dim = 0; dim < length; dim++) {
                sum[dim] /= magnitude;
            }
            next.push(sum);
        }
        centroids = next;
    }
    for (const memberFloat of memberFloats) {
        releaseFloat32(memberFloat);
    }
    return centroids.length;
}

function time(name: string, run: () => number): number {
    const start = Date.now();
    const clusters = run();
    const seconds = (Date.now() - start) / 1000;
    console.log(`  ${name.padEnd(10)} ${seconds.toFixed(3)}s   (${clusters} clusters)`);
    return seconds;
}

async function main() {
    const members = await loadEmbeddings(5000);
    const clusterCount = 40;
    const iterations = 4;
    console.log(`k-means: ${members.length} members, ${clusterCount} clusters, ${iterations} iterations\n`);

    kmeans(members.slice(0, 500), 8, 1, getCloseness); // warm up the JIT

    time("getCloseness", () => kmeans(members, clusterCount, iterations, getCloseness));
    time("f32-once", () => kmeansFloat32Once(members, clusterCount, iterations));
}

main();
