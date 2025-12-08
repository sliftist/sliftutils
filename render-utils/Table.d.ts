import preact from "preact";
import { JSXFormatter } from "./GenericFormat";
export type ColumnType<T = unknown, Row extends RowType = RowType> = undefined | null | {
    center?: boolean;
    title?: preact.ComponentChild;
    formatter?: JSXFormatter<T, Row>;
};
export type RowType = {
    [columnName: string]: unknown;
};
export type ColumnsType = {
    [columnName: string]: ColumnType;
};
export type TableType<RowT extends RowType = RowType> = {
    columns: {
        [columnName in keyof RowT]?: ColumnType<RowT[columnName], RowT>;
    };
    rows: RowT[];
};
export declare class Table<RowT extends RowType> extends preact.Component<TableType<RowT> & {
    class?: string;
    cellClass?: string;
    initialLimit?: number;
    lineLimit?: number;
    characterLimit?: number;
    excludeEmptyColumns?: boolean;
    getRowFields?: (row: RowT) => preact.JSX.HTMLAttributes<HTMLTableRowElement>;
}> {
    state: {
        limit: number;
    };
    render(): preact.JSX.Element;
}
