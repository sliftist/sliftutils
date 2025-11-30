
export type SourceMap = {
    version: number;
    file: string;
    sourceRoot: "",
    sources: string[];
    sourcesContent: string[];
    names: never[];
    mappings: string;
};
export type SourceMapping = {
    generatedLine: number;
    generatedColumn: number;
    sourceIndex: number;
    originalLine: number;
    originalColumn: number;
};
export type InProgressSourceMap = {
    sources: {
        name: string;
        contents: string;
    }[];
    mappings: SourceMapping[];
};

export function removeSourceMap(content: string): {
    sourceMap: SourceMap | undefined;
    code: string;
} {
    // Remove any url mappings (so NOT data ones)
    content = content.replace(/\/\/# sourceMappingURL=(?!data:)[^\s]+$/m, "// removed url sourcemap");

    const sourceMapRegex = /\/\/# sourceMappingURL=data:application\/json;base64,([^\s]+)$/m;
    const match = content.match(sourceMapRegex);

    if (!match) {
        return { sourceMap: undefined, code: content };
    }

    let sourceMapJson = Buffer.from(match[1], "base64").toString();
    // HACK: If the sourcemap is invalid, try to remove trailing characters. For some reason we sometimes have
    //  extra characters at the end? Also try to add some characters too?
    function isJSON(str: string): boolean {
        try {
            JSON.parse(str);
            return true;
        } catch {
            return false;
        }
    }
    for (let i = 0; i < 3; i++) {
        if (isJSON(sourceMapJson)) {
            break;
        }
        sourceMapJson = sourceMapJson.slice(0, -1);
    }
    if (!isJSON(sourceMapJson)) {
        if (isJSON(sourceMapJson + "]}")) {
            sourceMapJson = sourceMapJson + "]}";
        }
    }

    try {
        const sourceMap = JSON.parse(sourceMapJson) as SourceMap;

        // Remove the sourcemap line but keep the code
        content = content.replace(sourceMapRegex, "// merged inline sourcemap");

        return { sourceMap, code: content };
    } catch {
        console.log(`Invalid source map: ${sourceMapJson}`);
        return { sourceMap: undefined, code: content };
    }
}
function decodeMappings(mappings: string): SourceMapping[] {
    const vlqTable = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const vlqDecode = new Map(Array.from(vlqTable).map((c, i) => [c, i]));

    function decodeVLQ(str: string, pos: { value: number }): number {
        let result = 0;
        let shift = 0;
        let continuation: boolean;

        do {
            const c = str[pos.value++];
            const digit = vlqDecode.get(c);
            if (digit === undefined) {
                throw new Error(`Invalid VLQ character: ${JSON.stringify(c)}`);
            }
            continuation = (digit & 32) > 0;
            const value = digit & 31;
            result += value << shift;
            shift += 5;
        } while (continuation);

        const shouldNegate = result & 1;
        result >>>= 1;
        return shouldNegate ? -result : result;
    }

    const result: SourceMapping[] = [];
    let generatedLine = 1;
    let generatedColumn = 0;
    let sourceIndex = 0;
    let originalLine = 1;
    let originalColumn = 0;

    const segments = mappings.split(";");
    for (let i = 0; i < segments.length; i++) {
        const line = segments[i];
        if (!line) {
            generatedLine++;
            continue;
        }

        generatedColumn = 0;
        const fields = line.split(",");

        for (const field of fields) {
            if (!field) continue;

            const pos = { value: 0 };
            const segmentData = [];

            while (pos.value < field.length) {
                segmentData.push(decodeVLQ(field, pos));
            }

            if (segmentData.length < 4) continue;

            generatedColumn += segmentData[0];
            sourceIndex += segmentData[1];
            originalLine += segmentData[2];
            originalColumn += segmentData[3];

            result.push({
                generatedLine,
                generatedColumn,
                sourceIndex,
                originalLine,
                originalColumn,
            });
        }
        generatedLine++;
    }

    return result;
}
export function getInProgressSourceMap(sourceMap: SourceMap): InProgressSourceMap {
    const sources = sourceMap.sources.map((name, i) => ({
        name,
        contents: sourceMap.sourcesContent[i] || "",
    }));

    const mappings = decodeMappings(sourceMap.mappings);

    return {
        sources,
        mappings,
    };
}

export function addToInProgressSourceMap(inProgress: InProgressSourceMap, newMappings: InProgressSourceMap) {
    const sourceIndexOffset = inProgress.sources.length;

    // Add new sources
    inProgress.sources.push(...newMappings.sources);

    // Add mappings with adjusted source indices
    for (const mapping of newMappings.mappings) {
        inProgress.mappings.push({
            ...mapping,
            sourceIndex: mapping.sourceIndex + sourceIndexOffset,
        });
    }
}

export function finalizeInProgressSourceMap(inProgress: InProgressSourceMap): SourceMap {
    const vlqTable = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function encodeVLQ(value: number): string {
        // Convert to zigzag encoding
        value = value < 0 ? (-value << 1) | 1 : value << 1;

        let result = "";
        do {
            let digit = value & 31;
            value >>>= 5;
            if (value > 0) {
                digit |= 32;
            }
            result += vlqTable[digit];
        } while (value > 0);

        return result;
    }

    // Sort mappings by generated position
    const sortedMappings = [...inProgress.mappings].sort((a, b) => {
        if (a.generatedLine !== b.generatedLine) {
            return a.generatedLine - b.generatedLine;
        }
        return a.generatedColumn - b.generatedColumn;
    });

    // Generate the mappings string
    let prevGenLine = 1;
    let prevGenColumn = 0;
    let prevSourceIndex = 0;
    let prevOrigLine = 1;
    let prevOrigColumn = 0;

    const lines: string[] = [];
    let currentLine: string[] = [];

    for (const mapping of sortedMappings) {
        if (mapping.generatedLine > prevGenLine) {
            lines.push(currentLine.join(","));
            for (let i = prevGenLine + 1; i < mapping.generatedLine; i++) {
                lines.push("");
            }
            currentLine = [];
            prevGenColumn = 0;
        }

        const segment = [
            encodeVLQ(mapping.generatedColumn - prevGenColumn),
            encodeVLQ(mapping.sourceIndex - prevSourceIndex),
            encodeVLQ(mapping.originalLine - prevOrigLine),
            encodeVLQ(mapping.originalColumn - prevOrigColumn),
        ];

        currentLine.push(segment.join(""));

        prevGenLine = mapping.generatedLine;
        prevGenColumn = mapping.generatedColumn;
        prevSourceIndex = mapping.sourceIndex;
        prevOrigLine = mapping.originalLine;
        prevOrigColumn = mapping.originalColumn;
    }

    if (currentLine.length > 0) {
        lines.push(currentLine.join(","));
    }

    return {
        version: 3,
        file: "",
        sourceRoot: "",
        sources: inProgress.sources.map(s => s.name),
        sourcesContent: inProgress.sources.map(s => s.contents),
        names: [],
        mappings: lines.join(";"),
    };
}
export function encodeSourceMapLineComment(sourceMap: SourceMap): string {
    const sourceMapJson = JSON.stringify(sourceMap);
    const base64 = Buffer.from(sourceMapJson).toString("base64");
    // NOTE: Don't write it as one string, as then we are detected as a sourcemap, and break sourcemaps...
    return "//" + `# sourceMappingURL=data:application/json;base64,${base64}`;
}