export function getArg(name: string): string | undefined {
    let index = process.argv.indexOf(`--${name}`);
    if (index < 0) return undefined;
    let value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for --${name}`);
    }
    return value;
}
