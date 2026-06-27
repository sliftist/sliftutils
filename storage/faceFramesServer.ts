import http from "http";
import fs from "fs";
import path from "path";

// Throwaway HTTP server that serves the face-embedding test files so the benchmarks can be run from another
// machine (which downloads + caches a prefix via faceFramesData). Supports range requests, so a client only
// pulls the bytes it needs out of the 7.7GB full file. Meant to be left running in the background; it dies on
// reboot and that is fine. Run with: typenode storage/faceFramesServer.ts
const DATA_DIR = "/root/claude-work/face-embeddings";
const PORT = Number(process.env.PORT) || 8799;

function resolveFile(requestPath: string): string | undefined {
    const name = path.basename(decodeURIComponent(requestPath));
    if (!name.endsWith(".f32")) {
        return undefined;
    }
    const full = path.join(DATA_DIR, name);
    if (!fs.existsSync(full)) {
        return undefined;
    }
    return full;
}

const server = http.createServer((request, response) => {
    const filePath = resolveFile(request.url || "");
    if (!filePath) {
        response.writeHead(404);
        response.end("not found");
        return;
    }
    const total = fs.statSync(filePath).size;
    const rangeHeader = request.headers.range;
    const rangeMatch = rangeHeader ? /bytes=(\d+)-(\d*)/.exec(rangeHeader) : null;
    if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = rangeMatch[2] ? Number(rangeMatch[2]) : total - 1;
        response.writeHead(206, {
            "Content-Type": "application/octet-stream",
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Content-Length": end - start + 1,
        });
        fs.createReadStream(filePath, { start, end }).pipe(response);
        return;
    }
    response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Content-Length": total,
    });
    fs.createReadStream(filePath).pipe(response);
});

server.listen(PORT, () => {
    console.log(`serving ${DATA_DIR}/*.f32 on port ${PORT}`);
});
