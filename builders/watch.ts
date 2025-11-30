import fs from "fs";
import path from "path";
import { runPromise } from "socket-function/src/runPromise";

const DEBOUNCE_DELAY_MS = 250;

async function main() {
    let args = process.argv.slice(2);

    if (args.length < 2) {
        console.error("Usage: watch <pattern1> [pattern2...] <command>");
        console.error("Example: watch '*.ts' '*.tsx' 'yarn build'");
        console.error("  - Patterns with wildcards must match the entire path");
        console.error("  - Patterns without wildcards can appear anywhere in the path");
        process.exit(1);
    }

    let patterns = args.slice(0, -1);
    let command = args[args.length - 1];

    console.log(`Watching patterns: ${patterns.join(", ")}`);
    console.log(`Running command: ${command}`);
    console.log("");

    let currentDirectory = process.cwd();
    let debounceTimer: NodeJS.Timeout | undefined;
    let isRunning = false;
    let needsRerun = false;

    async function executeCommand() {
        if (isRunning) {
            needsRerun = true;
            return;
        }

        isRunning = true;
        needsRerun = false;

        try {
            console.log(`\n[${new Date().toLocaleTimeString()}] Running: ${command}`);
            await runPromise(command);
            console.log(`[${new Date().toLocaleTimeString()}] Completed successfully`);
        } catch (error) {
            console.error(`[${new Date().toLocaleTimeString()}] Error:`, error);
        } finally {
            isRunning = false;

            if (needsRerun) {
                console.log(`[${new Date().toLocaleTimeString()}] Detected changes during build, running again...`);
                await executeCommand();
            }
        }
    }

    function scheduleRun() {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
            void executeCommand();
        }, DEBOUNCE_DELAY_MS);
    }

    function matchesPattern(filePath: string, pattern: string): boolean {
        let relativePath = path.relative(currentDirectory, filePath).replace(/\\/g, "/");

        // If pattern contains wildcards, do full pattern matching
        if (pattern.includes("*") || pattern.includes("?")) {
            // Convert glob pattern to regex
            // Handle ** for recursive directory matching
            let regexPattern = pattern
                .replace(/\./g, "\\.") // Escape dots
                .replace(/\*\*/g, "<!RECURSIVE!>") // Placeholder for **
                .replace(/\*/g, "[^/]*") // * matches anything except /
                .replace(/<!RECURSIVE!>/g, ".*") // ** matches anything including /
                .replace(/\?/g, "."); // ? matches single character
            let regex = new RegExp(`^${regexPattern}$`);
            return regex.test(relativePath);
        } else {
            // No wildcards - pattern can appear anywhere in the path
            return relativePath.includes(pattern);
        }
    }

    function shouldWatch(filePath: string): boolean {
        for (let pattern of patterns) {
            if (matchesPattern(filePath, pattern)) {
                return true;
            }
        }
        return false;
    }

    function watchDirectory(dir: string) {
        try {
            let watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
                if (!filename) return;

                let fullPath = path.join(dir, filename);

                if (shouldWatch(fullPath)) {
                    console.log(`[${new Date().toLocaleTimeString()}] Detected change: ${path.relative(currentDirectory, fullPath)}`);
                    scheduleRun();
                }
            });

            watcher.on("error", (error) => {
                console.error(`Watch error for ${dir}:`, error);
            });
        } catch (error) {
            console.error(`Failed to watch directory ${dir}:`, error);
        }
    }

    // Start watching the current directory
    watchDirectory(currentDirectory);

    // Run the command once on startup
    console.log("Initial build starting...");
    await executeCommand();

    console.log("\nWatching for changes... (Press Ctrl+C to exit)");
}

main().catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
});

