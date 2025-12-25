import cborx from "cbor-x";
import { lazy } from "socket-function/src/caching";
const cborxInstance = lazy(() => new cborx.Encoder({
    structuredClone: true,
}));
export function cborEncode<T>(value: T): Buffer {
    return cborxInstance().encode(value);
}
export function cborDecode<T>(buffer: Buffer): T {
    return cborxInstance().decode(buffer);
}