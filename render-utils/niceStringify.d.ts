export declare const niceStringifyTrue = "";
export declare const niceStringifyNan = "{NaN}";
export declare const niceStringifyUndefined = "{Undefined}";
export declare function niceStringify(value: unknown): string;
export declare function niceParse(str: string | undefined, noSpecialTrue?: boolean): unknown;
