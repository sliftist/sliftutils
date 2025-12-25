import preact from "preact";
export declare const errorMessage: string;
export declare const warnMessage: string;
export type RowType = {
    [columnName: string]: unknown;
};
export type FormatContext<RowT extends RowType = RowType> = {
    row?: RowT;
    columnName?: RowT extends undefined ? string : keyof RowT;
};
export type JSXFormatter<T = unknown, RowT extends RowType = RowType> = (StringFormatters | `varray:${StringFormatters}` | `link:${string}` | ((value: T, context?: FormatContext<RowT>) => preact.ComponentChild));
type StringFormatters = ("guess" | "string" | "number" | "timeSpan" | "date" | "error" | "link" | "toSpaceCase");
export declare function toSpaceCase(text: string): string;
export declare function formatValue(value: unknown, formatter?: JSXFormatter, context?: FormatContext): preact.ComponentChild;
export {};
