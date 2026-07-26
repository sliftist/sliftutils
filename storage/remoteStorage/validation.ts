export function assertValidName(value: string, kind: string): void {
    if (!/^[\w-]{1,64}$/.test(value)) {
        throw new Error(`Invalid ${kind} ${JSON.stringify(value)}, expected 1-64 characters of letters/numbers/underscore/dash`);
    }
}

/** A store's name (see CommonConfig.name), which also allows dots - a name is often a host or a version, and both read wrong without them. It is one path segment of the store's folder, so the two names that would mean a different folder entirely are rejected: everything else containing dots is just a name. */
export function assertValidSourceName(value: string): void {
    if (!/^[\w.-]{1,64}$/.test(value)) {
        throw new Error(`Invalid source name ${JSON.stringify(value)}, expected 1-64 characters of letters/numbers/underscore/dash/dot`);
    }
    if (/^\.+$/.test(value)) {
        throw new Error(`Invalid source name ${JSON.stringify(value)}: a name of only dots refers to a directory rather than naming one`);
    }
}

export function assertValidPath(path: string): void {
    if (Buffer.from(path, "utf8").length > 1000) {
        throw new Error(`Path too long: ${path.length} characters > 1000. Path: ${path.slice(0, 200)}`);
    }
    if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("//") || path.includes("\\") || path.includes("\x00")) {
        throw new Error(`Invalid path ${JSON.stringify(path.slice(0, 200))}, paths cannot be empty, start or end with /, or contain //, backslashes, or null characters`);
    }
    if (path.split("/").some(part => part === "." || part === "..")) {
        throw new Error(`Invalid path ${JSON.stringify(path.slice(0, 200))}, paths cannot contain . or .. segments`);
    }
}

/** Method decorator: validates the well-known fields of the method's single config-object argument - account/bucketName as names, path as a path - before the method runs. Fields the config doesn't have are skipped, so it applies to every API method uniformly. prefix is deliberately NOT validated: prefixes may be empty or end with "/", both invalid for paths. */
export function assertValidArgs(target: unknown, key: string, descriptor: PropertyDescriptor): void {
    let original = descriptor.value as (...args: unknown[]) => unknown;
    descriptor.value = function (...args: unknown[]): unknown {
        let config = args[0] as { account?: string; bucketName?: string; path?: string } | undefined;
        if (config && typeof config === "object") {
            if ("account" in config) assertValidName(config.account as string, "account");
            if ("bucketName" in config) assertValidName(config.bucketName as string, "bucket name");
            if ("path" in config) assertValidPath(config.path as string);
        }
        return original.apply(this, args);
    };
}
