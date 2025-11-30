

export class Zip {
    public static async gzip(buffer: Buffer, level?: number): Promise<Buffer> {
        return await doStream(new CompressionStream("gzip"), buffer);
    }
    public static async gunzip(buffer: Buffer): Promise<Buffer> {
        return await doStream(new DecompressionStream("gzip"), buffer);
    }

    public static async gunzipBatch(buffers: Buffer[]): Promise<Buffer[]> {
        let time = Date.now();
        buffers = await Promise.all(buffers.map(Zip.gunzip));
        time = Date.now() - time;
        //let totalSize = buffers.reduce((acc, buffer) => acc + buffer.length, 0);
        //console.log(`Gunzip ${formatNumber(totalSize)}B at ${formatNumber(totalSize / time * 1000)}B/s`);
        return buffers;
    }
}

async function doStream(stream: GenericTransformStream, buffer: Buffer): Promise<Buffer> {
    let reader = stream.readable.getReader();
    let writer = stream.writable.getWriter();
    let writePromise = writer.write(buffer);
    let closePromise = writer.close();

    let outputBuffers: Buffer[] = [];
    while (true) {
        let { value, done } = await reader.read();
        if (done) {
            await writePromise;
            await closePromise;
            return Buffer.concat(outputBuffers);
        }
        outputBuffers.push(Buffer.from(value));
    }
}