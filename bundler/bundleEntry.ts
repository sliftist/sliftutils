import path from "path";
import { bundle } from "./bundler";
import fs from "fs";

async function main() {
    // NOTE: Using yargs added ~0.5s to the time to run this, and considering we run in ~1s... that's just too much 
    let entryPoint = process.argv[2];
    let outputFolder = process.argv[3];
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

    let finalPath = `${outputFolder}/${name}`;
    let tempPath = `${finalPath}.tmp`;

    try {
        await fs.promises.writeFile(tempPath, bundled.bundle);
        await fs.promises.rename(tempPath, finalPath);
    } finally {
        try {
            await fs.promises.unlink(tempPath);
        } catch { }
    }
}
main().catch(console.error).finally(() => process.exit());
