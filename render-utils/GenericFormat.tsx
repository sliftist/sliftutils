import preact, { ContextType } from "preact";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { canHaveChildren } from "socket-function/src/types";
import { css } from "typesafecss";

export const errorMessage = css.hsl(0, 75, 50).color("white", "important", "soft")
    .padding("4px 6px", "soft")
    .whiteSpace("pre-wrap").display("inline-block", "soft")
    ;
export const warnMessage = css.hsl(50, 75, 50).color("hsl(0, 0%, 7%)", "important", "soft")
    .padding("4px 6px", "soft")
    .whiteSpace("pre-wrap").display("inline-block", "soft")
    ;

export type RowType = { [columnName: string]: unknown };
export type FormatContext<RowT extends RowType = RowType> = {
    row?: RowT;
    columnName?: RowT extends undefined ? string : keyof RowT;
};
export type JSXFormatter<T = unknown, RowT extends RowType = RowType> = (
    StringFormatters
    | `varray:${StringFormatters}`
    | `link:${string}`
    | ((value: T, context?: FormatContext<RowT>) => preact.ComponentChild)
);

type StringFormatters = (
    "guess"
    | "string" | "number"
    | "timeSpan" | "date"
    | "error" | "link"
    | "toSpaceCase"
);

function d(value: unknown, formattedValue: preact.ComponentChild) {
    if (value === undefined || value === null) {
        return "";
    }
    return formattedValue;
}

export function toSpaceCase(text: string) {
    return text
        // "camelCase" => "camel Case"
        //  "URL" => "URL"
        .replace(/([a-z][A-Z])/g, str => str[0] + " " + str[1])
        // "snake_case" => "snake case"
        .replace(/_([A-Za-z])/g, " $1")
        // "firstletter" => "Firstletter"
        .replace(/^./, str => str.toUpperCase())
        // "first letter" => "first Letter"
        .replace(/ ./, str => str.toUpperCase())
        // Convert multiple spaces to a single space
        .replace(/\s+/g, " ");
    ;
}

/** YYYY/MM/DD HH:MM:SS PM/AM */
function formatDateTime(time: number) {
    function p(s: number) {
        return s.toString().padStart(2, "0");
    }
    let date = new Date(time);
    let hours = date.getHours();
    let minutes = date.getMinutes();
    let seconds = date.getSeconds();
    let ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    let strTime = p(hours) + ":" + p(minutes) + ":" + p(seconds) + " " + ampm;
    return date.getFullYear() + "/" + p(date.getMonth() + 1) + "/" + p(date.getDate()) + " " + strTime;
}

const startGuessDateRange = +new Date(2010, 0, 1).getTime();
const endGuessDateRange = +new Date(2040, 0, 1).getTime();
let formatters: { [formatter in StringFormatters]: (value: unknown) => preact.ComponentChild } = {
    string: (value) => d(value, String(value || "")),
    number: (value) => d(value, formatNumber(Number(value))),
    timeSpan: (value) => d(value, formatTime(Number(value))),
    date: (value) => d(value, formatDateTime(Number(value))),
    error: (value) => d(value, <span className={errorMessage}>{String(value)}</span>),
    toSpaceCase: (value) => d(value, toSpaceCase(String(value))),
    link: (value) => {
        if (value === undefined || value === null) {
            return "";
        }
        let href = String(value);
        let str = String(value);
        // https://google.com<google> => href = https://google.com, str = google
        let match = str.match(/<([^>]+)>/);
        if (match) {
            href = str.slice(0, match.index);
            str = match[1];
        }
        return <a target="_blank" href={href}>{str}</a>;
    },
    guess: (value) => {
        if (typeof value === "number") {
            // NOTE: These special values don't represent real values, and if they are shown
            //  to the user, it is a mistake anyways. So instead of showing a large number
            //  that is not meaningful to the user, we show a string, so they the issue
            //  is not the system having a large number, but the system not changing
            //  the default value.
            if (value === Number.MAX_SAFE_INTEGER) {
                return "Number.MAX_SAFE_INTEGER";
            }
            if (value === Number.MIN_SAFE_INTEGER) {
                return "Number.MIN_SAFE_INTEGER";
            }
            if (value === Number.MAX_VALUE) {
                return "Number.MAX_VALUE";
            }
            if (value === Number.MIN_VALUE) {
                return "Number.MIN_VALUE";
            }
            // Infinity should be somewhat understood by the user, if they are even a little
            //  bit literate. Of course, the value is likely a bug, but at least the consequences
            //  may be inferrable (the threshold is +Infinity, so it will never be reached, etc).
            if (value === Number.POSITIVE_INFINITY) {
                return "+Infinity";
            }
            if (value === Number.NEGATIVE_INFINITY) {
                return "-Infinity";
            }
            // These are somewhat a mistake, and should almost always be displayed as ""
            if (Number.isNaN(value)) {
                return "";
            }

            if (startGuessDateRange < value && value < endGuessDateRange) {
                return formatters.date(value);
            }
            return formatters.number(value);
        }
        if (typeof value === "string" && value.startsWith("Error:")) {
            return formatters.error(value.slice("Error:".length));
        }
        if (typeof value === "string" && value.startsWith("https://")) {
            return formatters.link(value);
        }
        // Don't render nested objects, etc, otherwise passing large arrays
        //  could just in us blowing the output up, when their intention
        //  is to just show "Array()"
        if (Array.isArray(value) && !value.some(x => canHaveChildren(x))) {
            return formatValue(value, "varray:guess");
        }
        return formatters.string(value);
    },
};
function formatVArray(value: unknown[], formatter: StringFormatters) {
    if (!Array.isArray(value)) {
        return <span className={errorMessage}>Expected array, got {typeof value}</span>;
    }
    let values = value.map(v => {
        let formatted = formatValue(v, formatter);
        if (!canHaveChildren(formatted)) {
            return <span>{formatted}</span>;
        }
        return formatted;
    });
    return (
        <div className={css.vbox(4)}>
            {values}
        </div>
    );
}

export function formatValue(value: unknown, formatter: JSXFormatter = "guess", context?: FormatContext) {
    if (typeof formatter === "function") {
        return formatter(value, context);
    }
    let formatterT = formatter as StringFormatters;
    if (formatterT.startsWith("varray:")) {
        formatterT = formatterT.slice("varray:".length) as StringFormatters;
        return formatVArray(value as unknown[], formatterT);
    }
    if (formatterT.startsWith("link:")) {
        let href = formatterT.slice("link:".length);
        href = href.replaceAll("$VALUE$", String(value));
        return formatters.link(href);
    }
    if (!formatters[formatterT]) {
        throw new Error(`Unknown formatter: ${formatter}`);
    }
    return formatters[formatterT](value);
}