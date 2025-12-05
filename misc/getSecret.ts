
import { cache } from "socket-function/src/caching";
import os from "os";
import fs from "fs";

export const getSecret = cache(async function getSecret(key: string): Promise<string> {
    const jsonIndex = key.indexOf(".json");
    if (jsonIndex === -1) {
        const filePath = os.homedir() + "/" + key;
        return fs.readFileSync(filePath, "utf-8").trim();
    }

    const pathPart = key.slice(0, jsonIndex + ".json".length);
    const filePath = os.homedir() + "/" + pathPart;
    const contents = fs.readFileSync(filePath, "utf-8");
    const json = JSON.parse(contents);

    const keyPart = key.slice(jsonIndex + ".json.".length);
    if (!keyPart) {
        return JSON.stringify(json);
    }

    const value = json[keyPart];
    if (value === undefined) {
        throw new Error(`Expected key "${keyPart}" in ${filePath}, was undefined`);
    }
    return String(value);
});