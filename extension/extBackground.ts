import { isInChromeExtension } from "../misc/environment";

function main() {
    if (!isInChromeExtension()) {
        return;
    }

    chrome.runtime.onInstalled.addListener(() => {
        console.log("Extension installed!");
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log("Message received:", message);
        sendResponse({ status: "ok" });
    });
}

main();

