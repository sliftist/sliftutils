
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
