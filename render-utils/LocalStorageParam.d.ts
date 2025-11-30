export declare class LocalStorageParamStr {
    readonly storageKey: string;
    private defaultValue;
    private state;
    lastSetValue: string;
    constructor(storageKey: string, defaultValue?: string);
    forceUpdate(): void;
    get(): string;
    set(value: string): void;
    get value(): string;
    set value(value: string);
}
