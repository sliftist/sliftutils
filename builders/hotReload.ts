import { watchFilesAndTriggerHotReloading } from "socket-function/hot/HotReloadController";
import { isInBrowser, isInChromeExtension, isInChromeExtensionBackground, isInChromeExtensionContentScript } from "../misc/environment";

const DEFAULT_WATCH_PORT = 9876;
const CONTENT_SCRIPT_POLL_INTERVAL_MS = 1000;

export async function enableHotReloading(config?: {
    port?: number;
}) {
    if (isInChromeExtensionBackground()) {
        chromeExtensionBackgroundHotReload(config?.port);
    } else if (isInChromeExtensionContentScript()) {
        chromeExtensionContentScriptHotReload();
    } else if (typeof window !== "undefined" && typeof window.location && typeof window.location.reload === "function") {
        // For most reloadable environments, just refresh
        watchPortHotReload(config?.port, () => {
            window.location.reload();
        });
    } else {
        watchFilesAndTriggerHotReloading();
    }
}

function watchPortHotReload(port = DEFAULT_WATCH_PORT, onReload: () => void) {
    let reconnectTimer: number | undefined;
    let ws: WebSocket | undefined;

    let everConnected = false;

    function connect() {
        try {
            ws = new WebSocket(`ws://localhost:${port}`);

            ws.onopen = () => {
                console.log(`[Hot Reload] Connected to watch server on port ${port}`);
                everConnected = true;
            };

            ws.onmessage = (event) => {
                try {
                    let data = JSON.parse(event.data);
                    if (data.type === "build-complete" && data.success) {
                        console.log("[Hot Reload] Build complete, reloading...");
                        onReload();
                    }
                } catch (error) {
                    console.error("[Hot Reload] Failed to parse message:", error);
                }
            };

            ws.onerror = (error) => {
                console.warn(`[Hot Reload] WebSocket error. Use the watch script to enable watching.`);
            };

            ws.onclose = () => {
                if (everConnected) {
                    console.log("[Hot Reload] Disconnected from watch server, reconnecting in 2s...");
                    if (reconnectTimer) {
                        clearTimeout(reconnectTimer);
                    }
                    reconnectTimer = setTimeout(() => {
                        connect();
                    }, 2000) as any;
                }
            };
        } catch (error) {
            console.error("[Hot Reload] Failed to connect:", error);
        }
    }

    connect();
}

function chromeExtensionBackgroundHotReload(port = DEFAULT_WATCH_PORT) {
    watchPortHotReload(port, () => {
        chrome.runtime.reload();
    });
}

function chromeExtensionContentScriptHotReload() {
    // The background reloads the extension on build, which invalidates this
    // content script's extension context. We detect that by touching
    // chrome.storage.local on a poll — once the context is gone, the call
    // throws "Extension context invalidated" and we refresh the page.
    setInterval(() => {
        try {
            chrome.storage.local.get(null, () => {
                if (chrome.runtime.lastError) {
                    console.error("[Hot Reload] storage.get error:", chrome.runtime.lastError.message);
                }
            });
        } catch (error) {
            let message = (error as Error).message ?? "";
            if (message.includes("Extension context invalidated")) {
                console.log("[Hot Reload] Extension context invalidated, refreshing page...");
                window.location.reload();
                return;
            }
            console.error("[Hot Reload] poll error:", (error as Error).stack ?? error);
        }
    }, CONTENT_SCRIPT_POLL_INTERVAL_MS);
}
