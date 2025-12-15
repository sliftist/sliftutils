import { isNode } from "socket-function/src/misc";
import crypto from "crypto";

export function getSeededRandom(seed: number): () => number {
    // Multiply seed by a large prime
    seed = (seed + 0x1235234894) * 0x1fffffff % 0x7fffffff;
    let rand = sfc32(seed, seed, seed, seed);
    // Run a few time, to fully seed it
    for (let i = 0; i < 10; i++) {
        rand();
    }
    return rand;
    function sfc32(a: number, b: number, c: number, d: number) {
        return function () {
            a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
            var t = (a + b) | 0;
            a = b ^ b >>> 9;
            b = c + (c << 3) | 0;
            c = (c << 21 | c >>> 11);
            d = d + 1 | 0;
            t = t + d | 0;
            c = c + t | 0;
            return (t >>> 0) / 4294967296;
        };
    }
}

export function shuffle<T>(array: T[], seed: number) {
    let rand = getSeededRandom(seed);
    let indexes = Array(array.length).fill(0).map((x, i) => i);
    let shuffleValue = indexes.map(() => rand());
    indexes.sort((a, b) => shuffleValue[a] - shuffleValue[b]);
    return indexes.map(i => array[i]);
}

let randomData = new Uint8Array(8);
let randomDataF64 = new Float64Array(randomData.buffer);
export function secureRandom(): number {
    if (!isNode()) {
        window.crypto.getRandomValues(randomData);
    } else {
        crypto.getRandomValues(randomData);
    }
    return randomDataF64[0];
}