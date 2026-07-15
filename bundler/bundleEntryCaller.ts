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
    let base = `node -r ./node_modules/typenode/index.js ${JSON.stringify(bundleEntryPath)} ${JSON.stringify(entryPoint)} ${JSON.stringify(outputFolder)}`;
    // Run twice in SEPARATE processes. The first ("--warm") only imports the
    // entry, which compiles its whole graph into typenode's on-disk cache. The
    // second is a fresh process that imports from that warm cache — so typenode
    // never has to compile anything and never lazy-loads the TypeScript compiler,
    // which would otherwise be captured in require.cache and serialized (9 MB+)
    // into the output bundle. See bundleEntry.ts.
    await runPromise(`${base} --warm`);
    await runPromise(base);
}
