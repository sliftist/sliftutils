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

    // Warm pass: this process only exists to compile the entry's whole graph
    // (and this bundler's own modules, compiled at our startup) into typenode's
    // on-disk cache, then exit. The caller runs a SECOND, fresh process for the
    // real bundle — that process reads everything from the warm cache and so
    // never has typenode lazy-load the TypeScript compiler. Without this, a
    // cold-cache build (e.g. a fresh CI/server checkout, or an entry whose files
    // no other entry imports) leaves `typescript` in require.cache and the
    // bundler serializes the entire 9 MB+ compiler into the output bundle.
    if (process.argv[4] === "--warm") {
        return;
    }

    let name = path.basename(entryPoint);
    if (name.endsWith(".ts") || name.endsWith(".tsx")) {
        name = name.split(".").slice(0, -1).join(".");
    }

    let modules = Object.values(require.cache).filter(x => x?.id !== module.id);

    let bundled = await bundle({
        modules,
        rootPath: path.resolve("."),
        entryPoints: [entryPoint],
    });

    // Two artifacts: `name.js` without the sourcemap (the sourcemap is usually bigger than the code itself, so this is what production serves) and `name.debug.js` with the inline sourcemap appended (serve it behind something like a ?debug query param).
    async function write(finalPath: string, contents: string) {
        let tempPath = `${finalPath}.tmp`;
        try {
            await fs.promises.writeFile(tempPath, contents);
            await fs.promises.rename(tempPath, finalPath);
        } finally {
            try {
                await fs.promises.unlink(tempPath);
            } catch { }
        }
    }
    await write(`${outputFolder}/${name}.js`, bundled.bundle);
    await write(`${outputFolder}/${name}.debug.js`, bundled.bundle + "\n" + bundled.sourceMapComment);
}
main().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => process.exit());
