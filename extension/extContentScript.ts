import { enableHotReloading } from "../builders/hotReload";
import { isInChromeExtension } from "../misc/environment";

async function main() {
    if (!isInChromeExtension()) {
        return;
    }

    await enableHotReloading({ port: 9878 });

    console.log("Content script loaded! new");

    chrome.runtime.sendMessage({ type: "contentScriptLoaded" }, (response) => {
        console.log("Response from background:", response);
    });
}

main().catch(console.error);

