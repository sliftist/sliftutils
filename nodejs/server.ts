import { delay } from "socket-function/src/batching";
import { exampleFunction } from "./exampleFile";
import { enableHotReloading } from "../builders/hotReload";

async function main() {
    await enableHotReloading();
    while (true) {
        console.log(exampleFunction());
        await delay(1000);
    }
}

main().catch(console.error);

