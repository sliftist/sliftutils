import fs from "fs";
import { delay } from "socket-function/src/batching";
import { bundleEntryCaller } from "../bundler/bundleEntryCaller";
import yargs from "yargs";
import { formatTime } from "socket-function/src/formatting/format";
import path from "path";
import { getAllFiles } from "../misc/fs";

async function main() {
    // Check if Electron is installed
    let electronPath = path.resolve("./node_modules/electron");
    if (!fs.existsSync(electronPath)) {
        console.error("ERROR: Electron is not installed.");
        console.error("");
        console.error("Electron is too heavy to be included by default for non-electron projects.");
        console.error("Please manually add Electron to your package.json dependencies:");
        console.error("");
        console.error("  \"devDependencies\": {");
        console.error("    \"electron\": \"^33.2.1\"");
        console.error("  }");
        console.error("");
        console.error("Then run: yarn install");
        process.exit(1);
    }

    let time = Date.now();
    let yargObj = yargs(process.argv)
        .option("mainEntry", { type: "string", default: "./electron/electronMain.ts", desc: `Path to the main process entry point` })
        .option("rendererEntry", { type: "string", default: "./electron/electronRenderer.tsx", desc: `Path to the renderer process entry point` })
        .option("indexHtml", { type: "string", default: "./electron/electronIndex.html", desc: `Path to the index.html file` })
        .option("assetsFolder", { type: "string", default: "./assets", desc: `Path to the assets folder` })
        .option("outputFolder", { type: "string", default: "./build-electron", desc: `Output folder` })
        .argv || {}
        ;


    // Wait for any async functions to load. 
    await delay(0);

    let hasMainEntry = fs.existsSync(yargObj.mainEntry);
    let hasRendererEntry = fs.existsSync(yargObj.rendererEntry);
    let hasIndexHtml = fs.existsSync(yargObj.indexHtml);
    let hasAssets = fs.existsSync(yargObj.assetsFolder);

    if (!hasMainEntry) {
        throw new Error(`Main process entry point not found at ${yargObj.mainEntry}. Please specify with the --mainEntry option.`);
    }
    if (!hasRendererEntry) {
        throw new Error(`Renderer process entry point not found at ${yargObj.rendererEntry}. Please specify with the --rendererEntry option.`);
    }

    await fs.promises.mkdir(yargObj.outputFolder, { recursive: true });

    // Build main and renderer processes in parallel
    await Promise.all([
        bundleEntryCaller({
            entryPoint: yargObj.mainEntry,
            outputFolder: yargObj.outputFolder,
        }),
        bundleEntryCaller({
            entryPoint: yargObj.rendererEntry,
            outputFolder: yargObj.outputFolder,
        })
    ]);

    // Collect all files to copy
    let filesToCopy: string[] = [];

    if (hasIndexHtml) {
        filesToCopy.push(yargObj.indexHtml);
    }

    // Add assets folder files if it exists
    if (hasAssets) {
        for await (const file of getAllFiles(yargObj.assetsFolder)) {
            filesToCopy.push(file);
        }
    }

    // Copy all files with timestamp checking
    async function getTimestamp(filePath: string): Promise<number> {
        try {
            const stats = await fs.promises.stat(filePath);
            return stats.mtimeMs;
        } catch (error) {
            return 0;
        }
    }

    let filesCopied = 0;
    let root = path.resolve(".");
    for (const file of filesToCopy) {
        let sourcePath = path.resolve(file);
        if (!fs.existsSync(sourcePath)) {
            console.warn(`Warning: File not found: ${file}`);
            continue;
        }
        let relativePath = path.relative(root, sourcePath);
        let destPath = path.join(yargObj.outputFolder, relativePath);

        let sourceTimestamp = await getTimestamp(sourcePath);
        let destTimestamp = await getTimestamp(destPath);
        if (sourceTimestamp > destTimestamp) {
            await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
            await fs.promises.cp(sourcePath, destPath);
            filesCopied++;
        }
    }
    if (filesCopied > 0) {
        console.log(`Copied ${filesCopied} changed files`);
    }

    let duration = Date.now() - time;
    console.log(`Electron build completed in ${formatTime(duration)}`);
}
main().catch(console.error).finally(() => process.exit());

