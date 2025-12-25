/// <reference types="node" />
/// <reference types="node" />
import { MaybePromise } from "socket-function/src/types";
export declare class Zip {
    static gzip(buffer: Buffer, level?: number): Promise<Buffer>;
    static gunzip(buffer: Buffer): MaybePromise<Buffer>;
    static gunzipAsyncBase(buffer: Buffer): Promise<Buffer>;
    static gunzipUntracked(buffer: Buffer): Promise<Buffer>;
    static gunzipSync(buffer: Buffer): Buffer;
    private static gunzipUntrackedSync;
    static gunzipBatch(buffers: Buffer[]): Promise<Buffer[]>;
}
