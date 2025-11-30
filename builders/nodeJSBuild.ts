import fs from "fs";
import { delay } from "socket-function/src/batching";
import { bundleEntryCaller } from "../bundler/bundleEntryCaller";
import yargs from "yargs";
import { formatTime } from "socket-function/src/formatting/format";

async function main() {
    let time = Date.now();
    let yargObj = yargs(process.argv)
        .option("entryPoint", { type: "string", default: "./nodejs/server.ts", desc: `Path to the entry point file` })
        .option("outputFolder", { type: "string", default: "./build-nodejs", desc: `Output folder` })
        .argv || {}
        ;


    // Wait for any async functions to load. 
    await delay(0);

    await fs.promises.mkdir("./build-nodejs", { recursive: true });

    await bundleEntryCaller({
        entryPoint: yargObj.entryPoint,
        outputFolder: yargObj.outputFolder,
    });

    let duration = Date.now() - time;
    console.log(`NodeJS build completed in ${formatTime(duration)}`);
}
main().catch(console.error).finally(() => process.exit());