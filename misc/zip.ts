import { isNode } from "socket-function/src/misc";
import { measureFnc } from "socket-function/src/profiling/measure";
import zlib from "zlib";
import * as pako from "pako";

import { setFlag } from "socket-function/require/compileFlags";
import { MaybePromise } from "socket-function/src/types";
setFlag(require, "pako", "allowclient", true);

const SYNC_THRESHOLD_BYTES = 100_000_000;

export class Zip {
    @measureFnc
    public static async gzip(buffer: Buffer, level?: number): Promise<Buffer> {
        if (isNode()) {
            return new Promise((resolve, reject) => {
                zlib.gzip(buffer, { level }, (err: any, result: Buffer) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
        } else {
            // @ts-ignore
            return await doStream(new CompressionStream("gzip"), buffer);
        }
    }
    public static gunzip(buffer: Buffer): MaybePromise<Buffer> {
        // Switch to the synchronous version if the buffer is small. This is a lot faster in Node.js and clientside.
        //  - On tests of random small amounts of data, this seems to be up to 7X faster (on node). However, on non-random data, on the actual data we're using, it seems to be almost 50 times faster. So... definitely worth it...
        if (buffer.length < SYNC_THRESHOLD_BYTES) {
            let time = Date.now();
            let result = Zip.gunzipSync(buffer);
            let duration = Date.now() - time;
            if (duration > 50) {
                // Wait, so we don't lock up the main thread. And if we already wait it 50ms, then waiting for one frame is marginal, even client-side. 
                return ((async () => {
                    await new Promise(resolve => setTimeout(resolve, 0));
                    return result;
                }))();
            }
            return result;
        }
        return Zip.gunzipAsyncBase(buffer);
    }
    @measureFnc
    public static async gunzipAsyncBase(buffer: Buffer): Promise<Buffer> {
        return Zip.gunzipUntracked(buffer);
    }
    // A base function, so we can avoid instrumentation for batch calls
    public static async gunzipUntracked(buffer: Buffer): Promise<Buffer> {
        if (isNode()) {
            return await new Promise<Buffer>((resolve, reject) => {
                zlib.gunzip(buffer, (err: any, result: Buffer) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
        }
        return await doStream(new DecompressionStream("gzip"), buffer);
    }

    @measureFnc
    public static gunzipSync(buffer: Buffer): Buffer {
        return this.gunzipUntrackedSync(buffer);
    }
    private static gunzipUntrackedSync(buffer: Buffer): Buffer {
        if (isNode()) {
            return Buffer.from(zlib.gunzipSync(buffer));
        }
        return Buffer.from(pako.inflate(buffer));
    }

    @measureFnc
    public static async gunzipBatch(buffers: Buffer[]): Promise<Buffer[]> {
        let time = Date.now();
        buffers = await Promise.all(buffers.map(x => {
            if (x.length < SYNC_THRESHOLD_BYTES) {
                return this.gunzipUntrackedSync(x);
            }
            return this.gunzipUntracked(x);
        }));
        time = Date.now() - time;
        let totalSize = buffers.reduce((acc, buffer) => acc + buffer.length, 0);
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