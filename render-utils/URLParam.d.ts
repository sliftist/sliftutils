export declare class URLParam<T = unknown> {
    readonly key: string;
    private defaultValue;
    constructor(key: string, defaultValue?: T);
    valueSeqNum: {
        value: number;
    };
    get(): T;
    set(value: T): void;
    reset(): void;
    getOverride(value: T): [string, string];
    get value(): T;
    set value(value: T);
}
export declare function getResolvedParam(param: [URLParam, unknown] | [string, string]): [string, string];
export declare function batchURLParamUpdate(params: ([URLParam, unknown] | [string, string])[]): void;
export declare function getCurrentUrl(): string;
