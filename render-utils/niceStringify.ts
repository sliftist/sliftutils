// true => ""
// "" => JSON.stringify("")

export const niceStringifyTrue = "";
// Starting/ending with a JSON character means anything string that looks like this
//  will be encoded like: `"{Nan`, and it is impossible for an object to serialize to look like this.
export const niceStringifyNan = `{NaN}`;
export const niceStringifyUndefined = `{Undefined}`;


// BUG: This is actually broken for hex strings. Hex strings may sometimes be entirely numbers,
//  which means they will randomly change type.
function looksLikeJSON(str: string) {
    return (
        str === "null"
        || str === "true"
        || str === "false"
        || str[0] === `"` && str[str.length - 1] === `"`
        || str[0] === `[` && str[str.length - 1] === `]`
        || str[0] === `{` && str[str.length - 1] === `}`
        || (48 <= str.charCodeAt(0) && str.charCodeAt(0) <= 57)
        || str.length > 1 && str[0] === "-" && (48 <= str.charCodeAt(1) && str.charCodeAt(1) <= 57)
        || str === niceStringifyTrue
        || str === niceStringifyUndefined
    );
}

export function niceStringify(value: unknown): string {
    if (value === undefined) {
        return niceStringifyUndefined;
    }
    if (value === true) return niceStringifyTrue;
    if (Number.isNaN(value)) return niceStringifyNan;

    // Any strings that don't look like JSON, don't need to encoded as JSON, and can instead
    //  just be stored as strings.
    if (typeof value === "string" && !looksLikeJSON(value)) {
        return value;
    }


    let str = JSON.stringify(value);
    if (typeof value !== "object") {
        let testParse = niceParse(str);
        if (testParse !== value) {
            console.log(`niceStringify did not reverse correctly. Should have received ${JSON.stringify(value)}, did received ${JSON.stringify(testParse)}`);
            debugger;
        }
    }

    return str;
}

export function niceParse(str: string | undefined, noSpecialTrue = false): unknown {
    if (str === undefined) {
        return undefined;
    }
    if (str === niceStringifyTrue && !noSpecialTrue) return true;
    if (str === niceStringifyNan) return Number.NaN;
    if (str === niceStringifyUndefined) return undefined;
    if (str === "") return str;

    if (looksLikeJSON(str)) {
        try {
            return JSON.parse(str);
        } catch { }
    }
    return str;
}

/*

function setFromUrlValue(key: string, valueJSON: string) {
    if(isMaybeJSON(valueJSON)) {
        try {
            values[key] = JSON.parse(valueJSON);
            return;
        } catch { }
    }
    // Always set it, if it isn't JSON, just assume it is raw text.
    values[key] = valueJSON;
}
*/