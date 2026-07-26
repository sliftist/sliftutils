export function getArg(name: string): string | undefined {
    let index = process.argv.indexOf(`--${name}`);
    if (index < 0) return undefined;
    let value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for --${name}`);
    }
    return value;
}

/** A valueless boolean flag: true when --name is present (with nothing, or a following flag). */
export function getFlag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}
