export declare class URLParamStr {
    readonly urlKey: string;
    private state;
    lastSetValue: string;
    constructor(urlKey: string);
    forceUpdate(): void;
    get(): string;
    set(value: string): void;
    get value(): string;
    set value(value: string);
}
export declare function batchUrlUpdate<T>(code: () => T): T;
export declare function createLink(params: [URLParamStr, string][]): string;
