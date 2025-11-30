import { sha256 } from "js-sha256";
import { bundleRequire, BundleRequireConfig } from "./bundleRequire";
import { wrapModule } from "./bundleWrapper";
import { addToInProgressSourceMap, encodeSourceMapLineComment, finalizeInProgressSourceMap, getInProgressSourceMap, InProgressSourceMap, removeSourceMap } from "./sourceMaps";
import fs from "fs";

export async function bundle(config: {
    modules: (typeof require.cache[""])[];
    rootPath: string;
    entryPoints: string[];
}): Promise<{
    bundle: string;
}> {
    const { modules, rootPath, entryPoints } = config;

    // NOTE: We COULD use an "index source map", which contains other sourcemaps
    //  and gives offsets for them. However... tooling support will is better
    //  for regular sourcemaps, and it's more flexible.

    let inProgressSourceMap: InProgressSourceMap = {
        sources: [],
        mappings: [],
    };

    let code = "";
    let curLineCount = 0;
    for (let module of modules) {
        if (!module) continue;

        let newCode = wrapModule(module);

        let { sourceMap, code: newCode2 } = removeSourceMap(newCode);
        newCode = newCode2;
        if (sourceMap) {
            let inProgress = getInProgressSourceMap(sourceMap);
            for (let mapping of inProgress.mappings) {
                mapping.generatedLine += curLineCount;
            }
            addToInProgressSourceMap(inProgressSourceMap, inProgress);
        }

        code += newCode + "\n";
        curLineCount += (newCode.match(/\n/g) || []).length + 1;
    }
    code += "\n/* Inlined buffer implementation: */\n";
    code += `\n;\n${fs.readFileSync(__dirname + "/buffer.js").toString()}\n;\n`;
    code += `\n;globalThis.__BUNDLE_HASH__ = ${JSON.stringify(sha256(code))};`;
    let bundleConfig: BundleRequireConfig = {
        rootPath,
    };
    code += `;(${bundleRequire.toString()})(${JSON.stringify(bundleConfig)});`;
    // Delay the initial requires, so our extension can boot and we can debug startup errors
    code += "\n;setTimeout(() => {";
    for (let entryPoint of entryPoints) {
        code += `\n;globalThis.require(${JSON.stringify(entryPoint)});`;
    }
    code += "\n;});";
    code += "\n" + encodeSourceMapLineComment(finalizeInProgressSourceMap(inProgressSourceMap));
    return {
        bundle: code,
    };
}

declare global {
    var __BUNDLE_HASH__: string | undefined;
}

export function extractBundleHash(code: string) {
    let match = code.match(/;globalThis.__BUNDLE_HASH__ = "([^"]+)";/);
    if (!match) return undefined;
    return match[1];
}