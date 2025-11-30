import child_process from "child_process";
import { runPromise } from "socket-function/src/runPromise";
import path from "path";

export async function bundleEntryCaller(config: {
    entryPoint: string;
    outputFolder: string;
}) {
    let { entryPoint, outputFolder } = config;
    entryPoint = path.resolve(entryPoint).replace(/\\/g, "/");
    outputFolder = path.resolve(outputFolder).replace(/\\/g, "/");
    let bundleEntryPath = path.resolve(__dirname, "bundleEntry.ts").replace(/\\/g, "/");
    await runPromise(`yarn typenode ${JSON.stringify(bundleEntryPath)} --entryPoint ${JSON.stringify(entryPoint)} --outputFolder ${JSON.stringify(outputFolder)}`);
}
