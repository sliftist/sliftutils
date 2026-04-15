export function isDefined<T>(value: T | undefined | null): value is T {
    return value !== undefined && value !== null;
}


export function freezeObject(value: unknown) {
    if (!value) return value;
    Object.freeze(value);
}

export function deepFreezeObject(value: unknown) {
    if (!value) return;
    if (typeof value !== "object") return;
    if (Object.isFrozen(value)) return;

    Object.freeze(value);

    Object.getOwnPropertyNames(value).forEach(prop => {
        const propValue = (value as any)[prop];
        if (propValue && typeof propValue === "object") {
            deepFreezeObject(propValue);
        }
    });
}