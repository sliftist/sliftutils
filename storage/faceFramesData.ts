import fs from "fs";
import os from "os";
import path from "path";
import http from "http";

// Resolves a face-embedding test file to a local path that holds at least the requested number of bytes. On
// the machine that owns the data it just uses the original file. Anywhere else it downloads the missing prefix
// from the faceFramesServer over a range request and caches it in the temp dir, so re-runs only fetch what
// they haven't already. Point it at a different server with FACEFRAMES_URL.
const SOURCE_DIR = "/root/claude-work/face-embeddings";
const SERVER_BASE = process.env.FACEFRAMES_URL || "http://65.109.93.113:8799";

function downloadInto(fileName: string, start: number, endExclusive: number, cachePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const url = `${SERVER_BASE}/${fileName}`;
        const options = { headers: { Range: `bytes=${start}-${endExclusive - 1}` } };
        const request = http.get(url, options, response => {
            if (response.statusCode !== 206 && response.statusCode !== 200) {
                response.resume();
                reject(new Error(`${url} returned ${response.statusCode}`));
                return;
            }
            const out = fs.createWriteStream(cachePath, start ? { flags: "r+", start } : { flags: "w" });
            response.pipe(out);
            out.on("error", reject);
            response.on("error", reject);
            out.on("finish", resolve);
        });
        request.on("error", reject);
    });
}

export async function ensureFaceData(fileName: string, byteLength: number): Promise<string> {
    const local = path.join(SOURCE_DIR, fileName);
    if (fs.existsSync(local) && fs.statSync(local).size >= byteLength) {
        return local;
    }
    const cachePath = path.join(os.tmpdir(), fileName);
    let cachedBytes = 0;
    if (fs.existsSync(cachePath)) {
        cachedBytes = fs.statSync(cachePath).size;
    }
    if (cachedBytes < byteLength) {
        const megabytes = ((byteLength - cachedBytes) / 1e6).toFixed(0);
        console.log(`downloading ${megabytes}MB of ${fileName} from ${SERVER_BASE} -> ${cachePath}`);
        await downloadInto(fileName, cachedBytes, byteLength, cachePath);
    }
    return cachePath;
}
