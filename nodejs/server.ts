import http from "http";

async function main() {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Hello from Node.js!\n");
    });

    const port = 3000;
    server.listen(port, () => {
        console.log(`Server running at http://localhost:${port}/`);
    });
}

main().catch(console.error);

