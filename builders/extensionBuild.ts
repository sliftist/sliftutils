import fs from "fs";
import { delay } from "socket-function/src/batching";
import { bundleEntryCaller } from "../bundler/bundleEntryCaller";
import yargs from "yargs";
import { formatTime } from "socket-function/src/formatting/format";
import path from "path";
import { getAllFiles } from "../misc/fs";

async function main() {
    let time = Date.now();
    //todonext
    // We need to build both the extBackground.ts and extContentScript.ts
    // And copy the manifest.json
    // AND copy everything in ./assets which has updated
    let yargObj = yargs(process.argv)
        .option("backgroundEntry", { type: "string", default: "./extension/extBackground.ts", desc: `Path to the entry point file` })
        .option("contentEntry", { type: "string", default: "./extension/extContentScript.ts", desc: `Path to the entry point file` })
        .option("manifestPath", { type: "string", default: "./extension/manifest.json", desc: `Path to the manifest.json file` })
        .option("assetsFolder", { type: "string", default: "./assets", desc: `Path to the assets folder` })
        .option("outputFolder", { type: "string", default: "./build-extension", desc: `Output folder` })
        .argv || {}
        ;


    // Wait for any async functions to load. 
    await delay(0);

    let hasBackgroundEntry = fs.existsSync(yargObj.backgroundEntry);
    let hasContentEntry = fs.existsSync(yargObj.contentEntry);
    let hasManifest = fs.existsSync(yargObj.manifestPath);
    let hasAssets = fs.existsSync(yargObj.assetsFolder);

    if (!hasBackgroundEntry && !hasContentEntry) {
        throw new Error("No extension entry points found. Please specify at least one entry point with the --backgroundEntry or --contentEntry option. Or, create the default file at ./extBackground.ts or ./extContentScript.ts.");
    }
    if (!hasManifest) {
        throw new Error("No manifest file found. Please specify the manifest file with the --manifestPath option. Or, create the default file at ./manifest.json.");
    }

    await fs.promises.mkdir("./build-extension", { recursive: true });

    if (hasBackgroundEntry) {
        await bundleEntryCaller({
            entryPoint: yargObj.backgroundEntry,
            outputFolder: yargObj.outputFolder,
        });
    }
    if (hasContentEntry) {
        await bundleEntryCaller({
            entryPoint: yargObj.contentEntry,
            outputFolder: yargObj.outputFolder,
        });
    }
    await fs.promises.cp(yargObj.manifestPath, path.join(yargObj.outputFolder, "manifest.json"));

    // Parse manifest and collect referenced files
    let manifestContent = await fs.promises.readFile(yargObj.manifestPath, "utf-8");
    let manifest = JSON.parse(manifestContent);

    // Collect all files to copy
    let filesToCopy: string[] = [];

    // Helper to add icons (can be string or object of strings)
    function addIconPaths(icon: string | object | undefined) {
        if (!icon) return;
        if (typeof icon === "string") {
            filesToCopy.push(icon);
        } else if (typeof icon === "object") {
            for (const iconPath of Object.values(icon)) {
                if (typeof iconPath === "string") {
                    filesToCopy.push(iconPath);
                }
            }
        }
    }

    // Add manifest-referenced files
    if (manifest.action?.default_popup) filesToCopy.push(manifest.action.default_popup);
    if (manifest.browser_action?.default_popup) filesToCopy.push(manifest.browser_action.default_popup);
    if (manifest.page_action?.default_popup) filesToCopy.push(manifest.page_action.default_popup);
    if (manifest.options_page) filesToCopy.push(manifest.options_page);
    if (manifest.options_ui?.page) filesToCopy.push(manifest.options_ui.page);
    if (manifest.devtools_page) filesToCopy.push(manifest.devtools_page);
    if (manifest.sidebar_action?.default_panel) filesToCopy.push(manifest.sidebar_action.default_panel);
    if (manifest.chrome_url_overrides?.newtab) filesToCopy.push(manifest.chrome_url_overrides.newtab);
    if (manifest.chrome_url_overrides?.bookmarks) filesToCopy.push(manifest.chrome_url_overrides.bookmarks);
    if (manifest.chrome_url_overrides?.history) filesToCopy.push(manifest.chrome_url_overrides.history);

    // Add icons
    addIconPaths(manifest.icons);
    addIconPaths(manifest.action?.default_icon);
    addIconPaths(manifest.browser_action?.default_icon);
    addIconPaths(manifest.page_action?.default_icon);

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
        console.log(`Copied ${filesCopied} changed assets`);
    }

    let duration = Date.now() - time;
    console.log(`NodeJS build completed in ${formatTime(duration)}`);
}
main().catch(console.error).finally(() => process.exit());