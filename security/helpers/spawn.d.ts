/** An argument list rather than a shell string, so hostnames and paths can never be parsed as
    shell syntax. Resolves with the exit code instead of throwing, callers decide what a failure
    means. `inheritStderr` lets a child's own errors reach the terminal as they happen. */
export declare function spawnPromise(config: {
    command: string;
    args: string[];
    cwd?: string;
    input?: string;
    inheritStderr?: boolean;
    timeoutTime?: number;
}): Promise<{
    stdout: string;
    stderr: string;
    status: number | undefined;
    error: Error | undefined;
}>;
