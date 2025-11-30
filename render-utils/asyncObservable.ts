import { observable } from "mobx";

export function asyncCache<Args, T>(getValue: (args: Args) => Promise<T>): {
    (args: Args): T | undefined;
} {
    let cache = new Map<string, {
        result: {
            value?: T;
            error?: Error;
        };
    }>();
    return (args: Args) => {
        let key = JSON.stringify(args);
        let result = cache.get(key);
        if (result) {
            let r = result.result;
            if (r.error) throw r.error;
            return r.value;
        }
        result = {
            result: observable({
                value: undefined,
                error: undefined,
            }, undefined, { deep: false }),
        };
        cache.set(key, result);

        void (async () => {
            try {
                let value = await getValue(args);
                result.result.value = value;
            } catch (error) {
                result.result.error = error as Error;
            }
        })();
        // Access the observable so we're watching it
        result.result.error;
        return result.result.value;
    };
}