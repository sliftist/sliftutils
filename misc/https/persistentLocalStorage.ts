import { isNode } from "socket-function/src/misc";
import fs from "fs";
import os from "os";
import { MaybePromise } from "socket-function/src/types";
import { cache } from "socket-function/src/caching";

export function getKeyStore<T>(appName: string, key: string): {
    get(): MaybePromise<T | undefined>;
    set(value: T | null): MaybePromise<void>;
} {
    if (isNode()) {
        let path = os.homedir() + `/keystore_${appName}_` + key + ".json";
        return {
            get() {
                let contents: string | undefined = undefined;
                try { contents = fs.readFileSync(path, "utf8"); } catch { }
                if (!contents) return undefined;
                return JSON.parse(contents) as T;
            },
            set(value: T | null) {
                fs.writeFileSync(path, JSON.stringify(value));
            }
        };
    } else {
        return {
            get() {
                let json = localStorage.getItem(key);
                if (!json) return undefined;
                return JSON.parse(json) as T;
            },
            set(value: T | null) {
                localStorage.setItem(key, JSON.stringify(value));
            }
        };
    }
}