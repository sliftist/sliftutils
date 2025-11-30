import fs from "fs";
import { delay } from "socket-function/src/batching";
import { bundleEntryCaller } from "../bundler/bundleEntryCaller";
import yargs from "yargs";
import { formatTime } from "socket-function/src/formatting/format";
import path from "path";
import { getAllFiles } from "../misc/fs";

async function main() {
    let time = Date.now();
    let yargObj = yargs(process.argv)
        .option("entryPoint", { type: "string", default: "./web/browser.tsx", desc: `Path to the entry point file` })
        .option("indexHtml", { type: "string", default: "./web/index.html", desc: `Path to the index.html file` })
        .option("assetsFolder", { type: "string", default: "./assets", desc: `Path to the assets folder` })
        .option("outputFolder", { type: "string", default: "./build-web", desc: `Output folder` })
        .argv || {}
        ;


    // Wait for any async functions to load. 
    await delay(0);

    let hasEntryPoint = fs.existsSync(yargObj.entryPoint);
    let hasIndexHtml = fs.existsSync(yargObj.indexHtml);
    let hasAssets = fs.existsSync(yargObj.assetsFolder);

    if (!hasEntryPoint) {
        throw new Error(`Entry point not found at ${yargObj.entryPoint}. Please specify the entry point with the --entryPoint option.`);
    }

    await fs.promises.mkdir(yargObj.outputFolder, { recursive: true });

    await bundleEntryCaller({
        entryPoint: yargObj.entryPoint,
        outputFolder: yargObj.outputFolder,
    });

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
    console.log(`Web build completed in ${formatTime(duration)}`);
}
main().catch(console.error).finally(() => process.exit());

