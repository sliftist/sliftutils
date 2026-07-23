import * as fs from "fs";
import * as path from "path";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { sort } from "socket-function/src/misc";
import { TreeSummary } from "./treeSummary";

const SUMMARY_COUNT = 30;
const TIMING_RUNS = 20;
const SCAN_DIRS = [
    "D:/repos/qs-cyoa",
    "D:/repos/querysub",
    "D:/repos/socket-function",
    "D:/repos/sliftutils",
    "D:/repos/inference-weights",
];

// Matches the gitignored "test*.json" pattern, so the cache never gets tracked.
const CACHE_FILE = "D:/repos/sliftutils/test-files-cache.json";

type FileInfo = { path: string; size: number };
type FileSummary = { count: number; totalSize: number };

async function collectFiles(dirs: string[], output: FileInfo[]) {
    for (let dir of dirs) {
        let basePath = dir.endsWith("/") && dir || dir + "/";
        await collectDir(dir, basePath, output);
    }
}

async function collectDir(dir: string, basePath: string, output: FileInfo[]) {
    let entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (let entry of entries) {
        let fullPath = path.join(dir, entry.name);
        let entryPath = basePath + entry.name;
        if (entry.isDirectory()) {
            await collectDir(fullPath, entryPath + "/", output);
        } else if (entry.isFile()) {
            let stats = await fs.promises.stat(fullPath);
            output.push({ path: entryPath, size: stats.size });
        }
    }
}

function summarize(files: FileInfo[], weightBySize: boolean) {
    let tree = new TreeSummary<FileInfo, FileSummary>({
        getPath: file => file.path,
        createSummary: () => ({ count: 0, totalSize: 0 }),
        addToSummary: (file, summary) => {
            summary.count++;
            summary.totalSize += file.size;
        },
        mergeSummaries: (target, source) => {
            target.count += source.count;
            target.totalSize += source.totalSize;
        },
        getWeight: summary => {
            if (weightBySize) return summary.totalSize;
            return summary.count;
        },
        expectedOutputCount: 100,
    });
    let addStart = performance.now();
    for (let file of files) {
        tree.add(file);
    }
    let addTime = performance.now() - addStart;
    let queryStart = performance.now();
    let summaries = tree.getSummaries(SUMMARY_COUNT);
    for (let i = 1; i < TIMING_RUNS; i++) {
        summaries = tree.getSummaries(SUMMARY_COUNT);
    }
    let queryTime = (performance.now() - queryStart) / TIMING_RUNS;
    let label = weightBySize && "size" || "count";
    console.log(`\n=== weighted by ${label}, ${SUMMARY_COUNT} entries ===`);
    console.log(`add: ${formatTime(addTime)} total for ${formatNumber(files.length)} files, tracking ${formatNumber(tree.getTrackedNodeCount())} nodes, getSummaries: ${formatTime(queryTime)} avg over ${TIMING_RUNS} runs`);
    let totalWeight = 0;
    for (let entry of summaries) {
        totalWeight += entry.weight;
    }
    sort(summaries, entry => -entry.weight);
    // Verify each entry against the raw file list: assign every file to its most specific displayed entry (exact paths beat prefixes, longer prefixes beat shorter), which is the partition the entries claim to represent.
    let actuals = summaries.map(() => ({ count: 0, totalSize: 0 }));
    let unmatchedCount = 0;
    let unmatchedSize = 0;
    for (let file of files) {
        let bestIndex = -1;
        let bestLen = -1;
        for (let i = 0; i < summaries.length; i++) {
            let entryPath = summaries[i].path;
            if (entryPath.endsWith("*")) {
                let prefix = entryPath.slice(0, -1);
                if (prefix.length > bestLen && file.path.startsWith(prefix)) {
                    bestIndex = i;
                    bestLen = prefix.length;
                }
            } else if (file.path === entryPath && entryPath.length + 1 > bestLen) {
                bestIndex = i;
                bestLen = entryPath.length + 1;
            }
        }
        if (bestIndex === -1) {
            unmatchedCount++;
            unmatchedSize += file.size;
            continue;
        }
        actuals[bestIndex].count++;
        actuals[bestIndex].totalSize += file.size;
    }
    let shownPercent = 0;
    let specificPercent = 0;
    for (let i = 0; i < summaries.length; i++) {
        let entry = summaries[i];
        let percent = entry.weight / totalWeight * 100;
        shownPercent += percent;
        if (entry.kind === "self" || entry.kind === "subtree") {
            specificPercent += percent;
        }
        let actual = actuals[i];
        let diff = "";
        if (actual.count !== entry.summary.count || actual.totalSize !== entry.summary.totalSize) {
            diff = `  DIFF actual files=${formatNumber(actual.count)} size=${formatNumber(actual.totalSize)}B`;
        }
        console.log(`${percent.toFixed(1).padStart(5)}% ${entry.path.padEnd(60)} files=${formatNumber(entry.summary.count).padStart(6)} size=${(formatNumber(entry.summary.totalSize) + "B").padStart(8)}${diff}`);
    }
    if (unmatchedCount > 0) {
        console.log(`UNMATCHED: ${formatNumber(unmatchedCount)} files (${formatNumber(unmatchedSize)}B) matched no displayed entry`);
    }
    console.log(`top ${summaries.length} entries cover ${shownPercent.toFixed(1)}% (specific paths ${specificPercent.toFixed(1)}%, combined leftovers ${(shownPercent - specificPercent).toFixed(1)}%)`);
    // Entries are a strict partition (each file in exactly one entry), so these must match the real totals exactly.
    let entryCount = 0;
    let entrySize = 0;
    for (let entry of summaries) {
        entryCount += entry.summary.count;
        entrySize += entry.summary.totalSize;
    }
    let actualSize = 0;
    for (let file of files) {
        actualSize += file.size;
    }
    console.log(`entry totals: files=${formatNumber(entryCount)} (actual ${formatNumber(files.length)}), size=${formatNumber(entrySize)}B (actual ${formatNumber(actualSize)}B)`);
}

async function getFiles(): Promise<FileInfo[]> {
    try {
        let cached = JSON.parse(await fs.promises.readFile(CACHE_FILE, "utf8")) as { dirs: string[]; files: FileInfo[] };
        if (JSON.stringify(cached.dirs) === JSON.stringify(SCAN_DIRS)) {
            console.log(`loaded ${formatNumber(cached.files.length)} files from cache ${CACHE_FILE}`);
            return cached.files;
        }
        console.log(`cache dirs changed (cached ${JSON.stringify(cached.dirs)}, now ${JSON.stringify(SCAN_DIRS)}), rescanning`);
    } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
            console.log(`no cache file at ${CACHE_FILE}, scanning`);
        } else {
            console.log(`cache read failed, rescanning:`, (err as Error).stack ?? err);
        }
    }
    let files: FileInfo[] = [];
    let scanStart = performance.now();
    await collectFiles(SCAN_DIRS, files);
    await fs.promises.writeFile(CACHE_FILE, JSON.stringify({ dirs: SCAN_DIRS, files }));
    console.log(`scanned ${formatNumber(files.length)} files in ${formatTime(performance.now() - scanStart)}, cached to ${CACHE_FILE}`);
    return files;
}

async function main() {
    let files = await getFiles();
    console.log(`collected ${formatNumber(files.length)} files from ${SCAN_DIRS.join(", ")}`);
    summarize(files, true);
    summarize(files, false);
}

main().catch(e => {
    console.error((e as Error).stack ?? e);
    process.exit(1);
});
