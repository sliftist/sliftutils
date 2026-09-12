export declare const SUDO_PREAMBLE = "SUDO=\"\"; if [ \"$(id -u)\" -ne 0 ]; then SUDO=\"sudo -n\"; fi";
/** No host means this machine, so the very same script runs with nothing in front of it. Local and
    remote then do exactly the same thing, rather than being two pieces of code that have to be kept
    saying the same thing. */
export declare const THIS_MACHINE = "";
export declare function describeHost(host: string): string;
/** The host string is handed to ssh untouched. Users, keys and ports belong in the caller's ssh
    config, so BatchMode makes a missing setup fail immediately instead of prompting. */
export declare function runOverSSH(config: {
    host: string;
    script: string;
    input?: string;
    allowFailure?: boolean;
}): Promise<{
    stdout: string;
    stderr: string;
    status: number | undefined;
}>;
/** Returns undefined when the file does not exist, so a missing file reads differently from an
    empty one. */
export declare function readRemoteFile(config: {
    host: string;
    filePath: string;
}): Promise<string | undefined>;
export declare function writeRemoteFile(config: {
    host: string;
    filePath: string;
    contents: string;
    fileMode: string;
    directoryMode: string;
}): Promise<void>;
export declare function remoteCommandExists(config: {
    host: string;
    command: string;
}): Promise<boolean>;
