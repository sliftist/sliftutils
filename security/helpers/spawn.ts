import { spawn } from "child_process";

// PORTED CODE: security/authorizedKeys/daemon/portsecureDaemon.js contains a plain JS port of spawnPromise, so it can run
// with no dependencies. If you change one, make the matching change in the other.

/** An argument list rather than a shell string, so hostnames and paths can never be parsed as
    shell syntax. Resolves with the exit code instead of throwing, callers decide what a failure
    means. `inheritStderr` lets a child's own errors reach the terminal as they happen. */
export function spawnPromise(config: {
    command: string;
    args: string[];
    cwd?: string;
    input?: string;
    inheritStderr?: boolean;
}) {
    let { command, args, cwd, input, inheritStderr } = config;
    return new Promise<{ stdout: string; stderr: string; status: number | undefined; error: Error | undefined }>(resolve => {
        let child = spawn(command, args, {
            cwd,
            stdio: ["pipe", "pipe", inheritStderr && "inherit" || "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", chunk => stdout += chunk);
        child.stderr?.on("data", chunk => stderr += chunk);
        child.on("error", error => resolve({ stdout, stderr, status: undefined, error }));
        child.on("close", status => resolve({ stdout, stderr, status: status ?? undefined, error: undefined }));
        // A child that exits before reading everything would otherwise raise EPIPE.
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(input || "");
    });
}
