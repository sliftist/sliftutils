import { watchFilesAndTriggerHotReloading } from "socket-function/hot/HotReloadController";
import { isInBrowser, isInChromeExtension, isInChromeExtensionBackground, isInChromeExtensionContentScript } from "../misc/environment";

const DEFAULT_WATCH_PORT = 9876;

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
                        console.log("[Hot Reload] Build complete, reloading page...");
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
    chrome.runtime.onConnect.addListener((port) => {
        if (port.name === "hotReload") {
            // Keep the port open so content scripts can detect when we disconnect
        }
    });

    watchPortHotReload(port, () => {
        chrome.runtime.reload();
    });
}

function chromeExtensionContentScriptHotReload() {
    let port = chrome.runtime.connect({ name: "hotReload" });

    let startTime = Date.now();

    port.onDisconnect.addListener(() => {
        let timeToFail = Date.now() - startTime;
        if (timeToFail > 10000) {
            console.warn("[Hot Reload] Could not connect to background script. Make sure the background script calls enableHotReloading().");
            return;
        }
        console.log("[Hot Reload] Extension reloaded, refreshing page...");
        window.location.reload();
    });
}