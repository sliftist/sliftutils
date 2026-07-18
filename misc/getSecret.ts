
import { cache } from "socket-function/src/caching";
import { isNode } from "typesafecss";

const secretStoragePrefix = "secret_";

function getStorageKey(key: string) {
    return secretStoragePrefix + key.replace(/[\/\\\.]/g, "_");
}

export function resetSecret(key: string) {
    if (isNode()) {
        throw new Error("resetSecret is only supported in the browser");
    }
    localStorage.removeItem(getStorageKey(key));
}

export const getSecret = cache(async function getSecret(key: string): Promise<string> {
    if (isNode()) {
        const os = await import("os");
        const fs = await import("fs");
        const path = await import("path");

        const appSecretsPath = path.resolve("./appSecrets");
        let appSecretsModule: { getAppSecret?: (key: string) => Promise<string | undefined> | string | undefined } | undefined;
        try {
            appSecretsModule = await import(appSecretsPath) as typeof appSecretsModule;
        } catch {
            // Module doesn't exist, fall through to the file-based approach
        }
        if (appSecretsModule?.getAppSecret) {
            const result = await appSecretsModule.getAppSecret(key);
            if (!result) {
                throw new Error(`Expected an app secret named "${key}" from getAppSecret in ${appSecretsPath}, but it returned no result`);
            }
            return result;
        }

        const jsonIndex = key.indexOf(".json");
        let filePath: string;
        try {
            if (jsonIndex === -1) {
                filePath = os.homedir() + "/" + key;
                return fs.readFileSync(filePath, "utf-8").trim();
            }

            const pathPart = key.slice(0, jsonIndex + ".json".length);
            filePath = os.homedir() + "/" + pathPart;
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
        } catch (e) {
            throw new Error(`Could not find secret "${key}". Expected it either from getAppSecret in the app secret module at ${appSecretsPath}, or in the file at ${os.homedir() + "/" + key}. Underlying error: ${(e as Error).stack ?? e}`);
        }
    }

    // Browser implementation
    const storageKey = getStorageKey(key);
    const cached = localStorage.getItem(storageKey);
    if (cached) {
        return cached;
    }

    // Show modal to prompt user for secret
    const { showFullscreenModal, FullscreenModal } = await import("../render-utils/FullscreenModal");
    const { showModal } = await import("../render-utils/modal");
    const { observable } = await import("mobx");
    const preact = await import("preact");

    return new Promise<string>((resolve) => {
        const state = observable({
            value: "",
        });

        const { close } = showModal({
            contents: preact.createElement(FullscreenModal, {
                onCancel: () => {
                    // Don't allow cancel without a value
                },
            },
                preact.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
                    preact.createElement("div", { style: { fontWeight: "bold" } }, `Enter secret for: ${key}`),
                    preact.createElement("input", {
                        style: { padding: 10, fontSize: 16 },
                        onInput: (e: Event) => {
                            state.value = (e.target as HTMLInputElement).value;
                        },
                        onKeyDown: (e: KeyboardEvent) => {
                            if (e.code === "Enter" && state.value) {
                                localStorage.setItem(storageKey, state.value);
                                close();
                                resolve(state.value);
                            }
                        },
                    }),
                    preact.createElement("button", {
                        style: { padding: 10, fontSize: 16, cursor: "pointer" },
                        onClick: () => {
                            if (state.value) {
                                localStorage.setItem(storageKey, state.value);
                                close();
                                resolve(state.value);
                            }
                        },
                    }, "Save"),
                ),
            ),
        });
    });
});

export function setSecret(key: string, value: string) {
    if (isNode()) {
        throw new Error("setSecret is only supported in the browser. We don't want to break the user's file system with setSecret in NodeJS.");
    }
    localStorage.setItem(getStorageKey(key), value);
}
