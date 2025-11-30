import preact from "preact";
import { css } from "typesafecss";
import { formatValue, JSXFormatter, toSpaceCase } from "./GenericFormat";
import { observer } from "./observer";
import { canHaveChildren } from "socket-function/src/types";
import { showFullscreenModal } from "./FullscreenModal";

// Null means the column is removed
export type ColumnType<T = unknown, Row extends RowType = RowType> = undefined | null | {
    center?: boolean;
    // Defaults to column name
    title?: preact.ComponentChild;
    formatter?: JSXFormatter<T, Row>;
};
export type RowType = {
    [columnName: string]: unknown;
};
export type ColumnsType = { [columnName: string]: ColumnType };
export type TableType<RowT extends RowType = RowType> = {
    columns: { [columnName in keyof RowT]?: ColumnType<RowT[columnName], RowT> };
    rows: RowT[];
};

@observer
export class Table<RowT extends RowType> extends preact.Component<TableType<RowT> & {
    class?: string;
    cellClass?: string;
    initialLimit?: number;

    // Line and character limits before we cut off the inner content
    lineLimit?: number;
    characterLimit?: number;

    excludeEmptyColumns?: boolean;
}> {
    state = {
        limit: this.props.initialLimit || 100,
    };
    render() {
        let { columns, rows, excludeEmptyColumns } = this.props;

        let cellClass = " " + String(this.props.cellClass || "") + " ";
        let allRows = rows;
        rows = rows.slice(0, this.state.limit);

        const lineLimit = this.props.lineLimit ?? 3;
        const characterLimit = this.props.characterLimit ?? 300;

        if (excludeEmptyColumns) {
            columns = { ...columns };
            for (let column of Object.keys(columns)) {
                if (!rows.some(row => row[column] !== undefined && row[column] !== null)) {
                    delete columns[column];
                }
            }
        }

        return (
            <table className={css.borderCollapse("collapse") + this.props.class}>
                <tr className={css.position("sticky").top(0).hsla(0, 0, 50, 0.95)}>
                    <th className={css.whiteSpace("nowrap")}>⧉ {allRows.length}</th>
                    {Object.entries(columns).filter(x => x[1] !== null).map(([columnName, column]: [string, ColumnType]) =>
                        <th className={css.pad2(8, 4) + cellClass}>{column?.title || toSpaceCase(columnName)}</th>
                    )}
                </tr>
                {rows.map((row, index) => (
                    <tr
                        className={(index % 2 === 1 && css.hsla(0, 0, 100, 0.25) || "")}
                    >
                        <td className={css.center}>{index + 1}</td>
                        {Object.entries(columns).filter(x => x[1] !== null).map(([columnName, column]: [string, ColumnType]) => {
                            let value = row[columnName];
                            let formatter = column?.formatter || "guess";
                            let result = formatValue(value, formatter, { row, columnName });
                            let renderedObj = renderTrimmed({
                                content: result,
                                lineLimit,
                                characterLimit,
                            });
                            let attributes = { ...renderedObj.outerAttributes };
                            attributes.class = attributes.class || "";
                            attributes.class += " " + css.whiteSpace("pre-wrap").pad2(8, 4);
                            if (column?.center) attributes.class += " " + css.verticalAlign("middle").textAlign("center");
                            attributes.class += cellClass;
                            // If the inner content looks like a VNode, take it's attributes and unwrap it,
                            //  so it can fill the entire cell.
                            let innerContent = renderedObj.innerContent;
                            if (
                                canHaveChildren(innerContent) && "props" in innerContent
                                && canHaveChildren(innerContent.props)
                                && "children" in innerContent.props
                                && (
                                    Array.isArray(innerContent.props.children) && innerContent.props.children.length === 1
                                    || !Array.isArray(innerContent.props.children)
                                )
                                // AND, it is a div or span (a tags shouldn't be unwrapped)
                                && (innerContent.type === "div")
                            ) {
                                attributes.class += " " + innerContent.props.class;
                                let baseOnClick = attributes.onClick;
                                let props = innerContent.props;
                                attributes.onClick = (e) => {
                                    if (baseOnClick) baseOnClick(e);
                                    (props as any).onClick?.(e);
                                };
                                for (let key in props) {
                                    if (key === "class") continue;
                                    if (key === "onClick") continue;
                                    (attributes as any)[key] = props[key];
                                }
                                innerContent = props.children as any;
                            }
                            return <td {...attributes}>
                                {innerContent}
                            </td>;
                        })}
                    </tr>
                ))}
                {allRows.length > rows.length && <tr>
                    <td
                        colSpan={1 + Object.keys(columns).length}
                        className={css.pad2(8).textAlign("center")}
                    >
                        <button onClick={() => this.state.limit += 100}>
                            {/* TODO: Load more as soon as they get close to the end.
                                - It doesn't really matter, as there is little reason for them to scroll far
                                    (they should just filter/search instead).
                            */}
                            Load more
                        </button>
                    </td>
                </tr>}
            </table>
        );
    }
}

function renderTrimmed(config: {
    content: preact.ComponentChild;
    lineLimit: number;
    characterLimit: number;
}): {
    outerAttributes: preact.JSX.HTMLAttributes<HTMLTableCellElement>;
    innerContent: preact.ComponentChild;
} {
    let { content, lineLimit, characterLimit } = config;
    if (typeof content !== "string" && typeof content !== "number") {
        return {
            outerAttributes: {},
            innerContent: content as any,
        };
    }
    let trimmed = false;
    let contentStr = String(content);
    if (contentStr.length > characterLimit) {
        contentStr = contentStr.slice(0, characterLimit - 3) + "...";
        trimmed = true;
    }
    let lines = contentStr.split("\n");
    if (lines.length > lineLimit) {
        lines = lines.slice(0, lineLimit);
        lines[lines.length - 1] += "...";
        contentStr = lines.join("\n");
        trimmed = true;
    }

    if (!trimmed) {
        return {
            outerAttributes: {},
            innerContent: contentStr,
        };
    }


    return {
        outerAttributes: {
            class: css.opacity(0.5, "hover").button,
            onClick: () => {
                showFullscreenModal(
                    <div className={css.whiteSpace("pre-wrap")}>
                        {content}
                    </div>
                );
            }
        },
        innerContent: contentStr
    };
}