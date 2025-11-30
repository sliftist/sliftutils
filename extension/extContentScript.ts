import { isInChromeExtension } from "../misc/environment";

function main() {
    if (!isInChromeExtension()) {
        return;
    }

    console.log("Content script loaded!");

    chrome.runtime.sendMessage({ type: "contentScriptLoaded" }, (response) => {
        console.log("Response from background:", response);
    });
}

main();

