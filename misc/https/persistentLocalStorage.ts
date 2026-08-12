import { isNode } from "socket-function/src/misc";
import fs from "fs";
import os from "os";
import { cache } from "socket-function/src/caching";

// Just used for machine maintenance (finding a key store file on disk, ex to copy it to another
// machine over ssh). NEVER access this unless explicitly given permission.
export function DEV_getKeyStorePath(config: { appName: string; key: string }): string {
    return os.homedir() + `/keystore_${config.appName}_` + config.key + ".json";
}

export function getKeyStore<T>(appName: string, key: string): {
    get(): T | undefined;
    set(value: T | null): void;
} {
    if (isNode()) {
        let path = DEV_getKeyStorePath({ appName, key });
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