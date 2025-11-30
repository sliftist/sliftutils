import { cache } from "socket-function/src/caching";
import path from "path";
import fs from "fs";

const getPackageJsonPath = cache((directory: string): string | undefined => {
    if (!directory.includes("/") && !directory.includes("\\")) {
        return undefined;
    }
    let packageJsonPath = path.resolve(directory, "package.json");
    if (fs.existsSync(packageJsonPath)) {
        return packageJsonPath;
    }
    return getPackageJsonPath(path.dirname(directory));
});
const getMainPath = cache((directory: string): string | undefined => {
    let packageJsonPath = getPackageJsonPath(directory);
    if (!packageJsonPath) return undefined;
    let packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    let dir = path.dirname(packageJsonPath);
    let mainName = packageJson.main;
    if (!mainName) {
        if (fs.existsSync(path.resolve(dir, "index.js"))) {
            mainName = "index.js";
        } else if (fs.existsSync(path.resolve(dir, "index.ts"))) {
            mainName = "index.ts";
        } else if (fs.existsSync(path.resolve(dir, "index.tsx"))) {
            mainName = "index.tsx";
        } else {
            mainName = "index.js";
        }
    }
    let mainPath = path.resolve(dir, mainName);
    return mainPath;
});


// Wraps the module so it registers itself when the returned code is evaluated
//  - See https://nodejs.org/api/modules.html#the-module-wrapper
export function wrapModule(module: NodeJS.Module): string {
    let contents = (module as any).moduleContents || "/* No contents */";

    // NOTE: debugName only matters during module evaluation. After that the sourcemap should work.
    let debugName = module.filename
        .replace(/\\/g, "/")
        .split("/")
        .slice(-1)[0]
        .replace(/\./g, "_")
        .replace(/[^a-zA-Z_]/g, "");

    let wrapped = `(function ${debugName}(exports, require, module, __filename, __dirname) { ${contents}
    })`;

    let moduleFields: { [flag: string]: unknown; } = {};
    for (let [key, value] of Object.entries(module)) {
        if (typeof value === "function") continue;
        if (typeof value === "boolean") {
            moduleFields[key] = value;
        } else if (typeof value === "string" && value.length < 150) {
            moduleFields[key] = value;
        } else if (typeof value === "number") {
            moduleFields[key] = value;
        }
    }

    let isModuleMain: string | undefined;
    let dirname = path.dirname(module.filename);
    let packageJsonPath = getPackageJsonPath(dirname);
    if (packageJsonPath) {
        let mainPath = getMainPath(dirname);
        if (mainPath?.replaceAll("\\", "/") === module.filename.replaceAll("\\", "/")) {
            // Then we are the main of the module
            isModuleMain = path.dirname(packageJsonPath).replaceAll("\\", "/");
        }
    }

    // NOTE: We can't have new lines, or they break source maps
    let objWrapped = `{`
        + ` id: ${JSON.stringify(module.id.replaceAll("\\", "/"))},`
        + ` filename: ${JSON.stringify(module.filename.replaceAll("\\", "/"))},`
        + ` isModuleMain: ${JSON.stringify(isModuleMain)},`
        + ` paths: ${JSON.stringify(module.paths.map(p => p.replaceAll("\\", "/")))},`
        + ` moduleFields: ${JSON.stringify(moduleFields)},`
        + ` moduleFnc: ${wrapped}`
        + ` }`;

    function initModule(serialized: SerializedModule) {
        globalThis.registeredModules = globalThis.registeredModules || {};
        globalThis.registeredModules[serialized.id] = serialized;
        if (serialized.isModuleMain) {
            globalThis.registeredModules[serialized.isModuleMain] = serialized;
        }
    }

    return `;(${initModule.toString().replaceAll("\n", " ")})(${objWrapped});`;
}

declare global {
    var registeredModules: { [id: string]: SerializedModule; } | undefined;
}

export interface SerializedModule {
    id: string;
    filename: string;

    // The main main we represent. Ex, "/ai3/node_modules/typesafecss"
    isModuleMain?: string;

    // Paths which the require function searches for non-relative imports
    paths: string[];

    // Fields to be set on the module, when it is created
    moduleFields: { [flag: string]: unknown; };

    moduleFnc: (exports: any, require: any, module: any, __filename: string, __dirname: string) => unknown;
}