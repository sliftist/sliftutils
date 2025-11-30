import path from "path";
import { bundle } from "./bundler";
import fs from "fs";
import yargs from "yargs";

async function main() {
    let yargObj = yargs(process.argv)
        .option("entryPoint", { type: "string", desc: `Path to the entry point file` })
        .option("outputFolder", { type: "string", desc: `Path to the output folder` })
        .argv || {}
        ;
    let entryPoint = yargObj.entryPoint;
    let outputFolder = yargObj.outputFolder;
    if (!entryPoint) {
        throw new Error("No entry point provided. Please use the --entryPoint option.");
    }
    if (!outputFolder) {
        throw new Error("No output folder provided. Please use the --outputFolder option.");
    }
    // We prefer production, as this is what the bundler uses internally. This ensures that in the build and when run, we will have the same environment, which will result in the same requires being called. 
    process.env.NODE_ENV = process.env.NODE_ENV || "production";
    require(entryPoint);

    let name = path.basename(entryPoint);
    if (name.endsWith(".ts") || name.endsWith(".tsx")) {
        name = name.split(".").slice(0, -1).join(".");
    }
    name += ".js";

    let modules = Object.values(require.cache).filter(x => x?.id !== module.id);

    let bundled = await bundle({
        modules,
        rootPath: path.resolve("."),
        entryPoints: [entryPoint],
    });
    await fs.promises.writeFile(`${yargObj.outputFolder}/${name}`, bundled.bundle);
}
main().catch(console.error).finally(() => process.exit());
