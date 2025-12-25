/// <reference types="node" />
/// <reference types="node" />
export declare function cborEncode<T>(value: T): Buffer;
export declare function cborDecode<T>(buffer: Buffer): T;
