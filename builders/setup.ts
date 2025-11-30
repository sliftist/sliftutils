import fs from "fs";
import path from "path";
import { execSync } from "child_process";

async function main() {
    let targetDir = path.resolve(".");
    let sourceDir = path.join(__dirname, "..");

    console.log("Setting up sliftutils project...");
    console.log(`Source: ${sourceDir}`);
    console.log(`Target: ${targetDir}`);

    // Directories and files to copy
    let directoriesToScan = ["electron", "extension", "web", "nodejs", "assets", ".vscode"];
    let rootFiles = [".cursorrules", ".eslintrc.js", ".gitignore", "tsconfig.json"];

    // Import path mappings to convert relative imports to package imports
    let importMappings: { [key: string]: string } = {
        "../builders/": "sliftutils/builders/",
        "../misc/": "sliftutils/misc/",
        "../render-utils/": "sliftutils/render-utils/",
        "../bundler/": "sliftutils/bundler/",
        "../storage/": "sliftutils/storage/",
    };

    // Gather all files to copy
    let filesToCopy: string[] = [];

    // Add root files
    for (let file of rootFiles) {
        let sourcePath = path.join(sourceDir, file);
        if (fs.existsSync(sourcePath)) {
            filesToCopy.push(file);
        }
    }

    // Gather files from directories
    for (let dir of directoriesToScan) {
        let sourcePath = path.join(sourceDir, dir);
        if (fs.existsSync(sourcePath)) {
            let filesInDir = gatherFilesRecursive(sourcePath, sourceDir);
            filesToCopy.push(...filesInDir);
        }
    }

    // Copy all files
    console.log(`\nFound ${filesToCopy.length} files to copy\n`);

    for (let relativePath of filesToCopy) {
        let sourcePath = path.join(sourceDir, relativePath);
        let targetPath = path.join(targetDir, relativePath);

        // Check if target already exists
        if (fs.existsSync(targetPath)) {
            console.log(`Skipping ${relativePath} (already exists)`);
            continue;
        }

        // Create directory if needed
        let targetDirPath = path.dirname(targetPath);
        if (!fs.existsSync(targetDirPath)) {
            fs.mkdirSync(targetDirPath, { recursive: true });
        }

        // Copy file with import processing for .ts/.tsx files
        if (relativePath.endsWith(".ts") || relativePath.endsWith(".tsx")) {
            let content = fs.readFileSync(sourcePath, "utf8");
            let processedContent = replaceImports(content, importMappings);
            fs.writeFileSync(targetPath, processedContent, "utf8");
            console.log(`Copied ${relativePath} (with import mapping)`);
        } else {
            fs.copyFileSync(sourcePath, targetPath);
            console.log(`Copied ${relativePath}`);
        }
    }

    // Update package.json with scripts
    let packageJsonPath = path.join(targetDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
        console.log("\nUpdating package.json scripts...");
        updatePackageJson(packageJsonPath);
    } else {
        console.warn("\nNo package.json found in target directory");
    }

    // Run yarn install
    console.log("\nRunning yarn install...");
    try {
        execSync("yarn install", { cwd: targetDir, stdio: "inherit" });
        console.log("Yarn install completed successfully");
    } catch (error) {
        console.error("Failed to run yarn install:", error);
        process.exit(1);
    }

    console.log("\nSetup complete!");
}

function gatherFilesRecursive(dir: string, baseDir: string): string[] {
    let files: string[] = [];
    let entries = fs.readdirSync(dir, { withFileTypes: true });

    for (let entry of entries) {
        let fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            // Skip dist directories
            if (entry.name === "dist") {
                continue;
            }
            let subFiles = gatherFilesRecursive(fullPath, baseDir);
            files.push(...subFiles);
        } else {
            // Add file as relative path from base directory
            let relativePath = path.relative(baseDir, fullPath);
            files.push(relativePath);
        }
    }

    return files;
}

function replaceImports(content: string, importMappings: { [key: string]: string }): string {
    let lines = content.split("\n");
    let processedLines = lines.map(line => {
        // Check if line contains an import or require statement
        if (line.includes("import") || line.includes("require")) {
            let processedLine = line;
            for (let [oldPath, newPath] of Object.entries(importMappings)) {
                processedLine = processedLine.replace(new RegExp(oldPath.replace(/\//g, "\\/"), "g"), newPath);
            }
            return processedLine;
        }
        return line;
    });
    return processedLines.join("\n");
}

function updatePackageJson(packageJsonPath: string) {
    let packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

    // Read our current package.json to get the type script
    let sourcePackageJsonPath = path.join(__dirname, "..", "package.json");
    let sourcePackageJson = JSON.parse(fs.readFileSync(sourcePackageJsonPath, "utf8"));

    if (!packageJson.scripts) {
        packageJson.scripts = {};
    }

    // Add type script (copied from source)
    if (!packageJson.scripts.type) {
        packageJson.scripts.type = sourcePackageJson.scripts.type;
        console.log("  Added 'type' script");
    }

    // Copy run commands from source (except run-web)
    let copiedCommands = ["run-nodejs", "run-nodejs-dev", "run-electron"];
    for (let cmd of copiedCommands) {
        if (!packageJson.scripts[cmd]) {
            packageJson.scripts[cmd] = sourcePackageJson.scripts[cmd];
            console.log(`  Added '${cmd}' script`);
        }
    }

    // Add hard-coded commands
    let hardCodedCommands: { [key: string]: string } = {
        "run-web": "node ./node_modules/sliftutils/builders/webRun.js",
        "build-nodejs": "build-nodejs",
        "build-web": "build-web",
        "build-extension": "build-extension",
        "build-electron": "build-electron",
        "watch-nodejs": "slift-watch --port 9876 \"nodejs/*.ts\" \"nodejs/*.tsx\" \"yarn build-nodejs\"",
        "watch-web": "slift-watch --port 9877 \"web/*.ts\" \"web/*.tsx\" \"yarn build-web\"",
        "watch-extension": "slift-watch --port 9878 \"extension/*.ts\" \"extension/*.tsx\" \"yarn build-extension\"",
        "watch-electron": "slift-watch --port 9879 \"electron/*.ts\" \"electron/*.tsx\" \"yarn build-electron\"",
    };

    for (let [scriptName, command] of Object.entries(hardCodedCommands)) {
        if (!packageJson.scripts[scriptName]) {
            packageJson.scripts[scriptName] = command;
            console.log(`  Added '${scriptName}' script`);
        }
    }

    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, undefined, 4) + "\n", "utf8");
    console.log("  package.json updated");
}

main().catch(error => {
    console.error("Setup failed:", error);
    process.exit(1);
});

