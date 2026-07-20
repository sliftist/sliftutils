import { Database } from "./Database";

// Rough byte size of a value, for the read/written-bytes metrics.
function sizeOf(value: unknown): number {
    if (value === undefined || value === null) {
        return 0;
    }
    if (value instanceof Uint8Array) {
        return value.byteLength;
    }
    if (typeof value === "string") {
        return value.length;
    }
    if (typeof value === "number") {
        return 8;
    }
    if (typeof value === "boolean") {
        return 1;
    }
    if (Array.isArray(value)) {
        let total = 0;
        for (const entry of value) {
            total += sizeOf(entry);
        }
        return total;
    }
    if (typeof value === "object") {
        let total = 0;
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record)) {
            total += sizeOf(record[key]);
        }
        return total;
    }
    return 0;
}

// Record the property path a dereference lambda walks, so a write/delete can be applied at it.
function capturePath(deref: (root: unknown) => unknown): string[] {
    const path: string[] = [];
    const handler: ProxyHandler<object> = {
        get(_target, key) {
            if (typeof key === "string") {
                path.push(key);
            }
            return new Proxy({}, handler);
        },
    };
    deref(new Proxy({}, handler));
    return path;
}

function setPath(root: Record<string, unknown>, path: string[], value: unknown): void {
    let node = root;
    for (let index = 0; index < path.length - 1; index++) {
        const key = path[index];
        const next = node[key];
        if (!next || typeof next !== "object") {
            node[key] = {};
        }
        node = node[key] as Record<string, unknown>;
    }
    node[path[path.length - 1]] = value;
}

function deletePath(root: Record<string, unknown>, path: string[]): void {
    let node = root;
    for (let index = 0; index < path.length - 1; index++) {
        const next = node[path[index]];
        if (!next || typeof next !== "object") {
            return;
        }
        node = next as Record<string, unknown>;
    }
    delete node[path[path.length - 1]];
}

// In-memory Database for tests/dev: holds the whole root as a plain object and counts every call plus the bytes flowing through. Synchronous and always "synced", so reads only return undefined for a genuinely missing scalar (a missing transaction set reads as empty inside the set helpers).
export class InMemoryDatabase<Root> implements Database<Root> {
    public readCalls = 0;
    public writeCalls = 0;
    public deleteCalls = 0;
    public bytesRead = 0;
    public bytesWritten = 0;
    private root: Record<string, unknown>;

    constructor(initial: Root) {
        this.root = initial as Record<string, unknown>;
    }

    readData<Value>(deref: (root: Root) => Value): Value | undefined {
        this.readCalls++;
        const result = deref(this.root as Root);
        this.bytesRead += sizeOf(result);
        return result;
    }
    writeData<Value>(deref: (root: Root) => Value, newValue: Value): void {
        this.writeCalls++;
        this.bytesWritten += sizeOf(newValue);
        setPath(this.root, capturePath(deref as (root: unknown) => unknown), newValue);
    }
    deleteData(deref: (root: Root) => unknown): void {
        this.deleteCalls++;
        deletePath(this.root, capturePath(deref as (root: unknown) => unknown));
    }
}
