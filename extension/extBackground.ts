import { enableHotReloading } from "../builders/hotReload";
import { isInChromeExtension } from "../misc/environment";

async function main() {
    if (!isInChromeExtension()) {
        return;
    }

    await enableHotReloading({ port: 9878 });

    chrome.runtime.onInstalled.addListener(() => {
        console.log("Extension installed!");
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log("Message received:", message, sender);
        sendResponse({ status: "ok 26" });
    });
}

main().catch(console.error);

