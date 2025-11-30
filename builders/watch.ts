import fs from "fs";
import path from "path";
import { runPromise } from "socket-function/src/runPromise";
import { WebSocketServer } from "ws";

const DEBOUNCE_DELAY_MS = 250;
const DEFAULT_WATCH_PORT = 9876;

async function main() {
    let args = process.argv.slice(2);

    if (args.length < 2) {
        console.error("Usage: watch [--port PORT] <pattern1> [pattern2...] <command>");
        console.error("Example: watch --port 9877 '*.ts' '*.tsx' 'yarn build'");
        console.error("  - Patterns with wildcards must match the entire path");
        console.error("  - Patterns without wildcards can appear anywhere in the path");
        process.exit(1);
    }

    // Parse port parameter if present
    let watchPort = DEFAULT_WATCH_PORT;
    let argIndex = 0;

    if (args[argIndex] === "--port") {
        if (args.length < 4) {
            console.error("--port requires a value");
            process.exit(1);
        }
        watchPort = parseInt(args[argIndex + 1], 10);
        if (isNaN(watchPort)) {
            console.error(`Invalid port number: ${args[argIndex + 1]}`);
            process.exit(1);
        }
        argIndex += 2;
    }

    let remainingArgs = args.slice(argIndex);
    let patterns = remainingArgs.slice(0, -1);
    let command = remainingArgs[remainingArgs.length - 1];

    let currentDirectory = process.cwd();

    // Setup WebSocket server (unless disabled with port <= 0)
    let wss: WebSocketServer | undefined;
    if (watchPort > 0) {
        wss = new WebSocketServer({ port: watchPort });
        console.log(`WebSocket server listening on port ${watchPort}. Use --port parameter to change this. Set it to 0 to disable watching.`);

        wss.on("connection", (ws) => {
            console.log(`[${new Date().toLocaleTimeString()}] WebSocket client connected`);
            ws.on("close", () => {
                console.log(`[${new Date().toLocaleTimeString()}] WebSocket client disconnected`);
            });
        });
    } else {
        console.log(`WebSocket server disabled (port <= 0)`);
    }

    console.log(`Watching patterns: ${patterns.join(", ")}`);
    console.log(`Running command: ${command}`);
    console.log("");

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

            // Notify all connected WebSocket clients
            if (wss) {
                wss.clients.forEach((client) => {
                    if (client.readyState === 1) { // 1 = OPEN
                        client.send(JSON.stringify({ type: "build-complete", success: true }));
                    }
                });
            }
        } catch (error) {
            console.error(`[${new Date().toLocaleTimeString()}] Error:`, error);

            // Notify clients about build error
            if (wss) {
                wss.clients.forEach((client) => {
                    if (client.readyState === 1) { // 1 = OPEN
                        client.send(JSON.stringify({ type: "build-complete", success: false }));
                    }
                });
            }
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
        let relativePath = path.relative(currentDirectory, filePath).replace(/\\/g, "/").toLowerCase();
        let lowerPattern = pattern.toLowerCase();

        // If pattern contains wildcards, do full pattern matching
        if (lowerPattern.includes("*")) {
            // Convert wildcard pattern to regex
            let regexPattern = lowerPattern
                .replace(/\./g, "\\.") // Escape dots
                .replace(/\*/g, ".*"); // * matches anything
            let regex = new RegExp(`^${regexPattern}$`);
            return regex.test(relativePath);
        } else {
            // No wildcards - pattern can appear anywhere in the path
            return relativePath.includes(lowerPattern);
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

