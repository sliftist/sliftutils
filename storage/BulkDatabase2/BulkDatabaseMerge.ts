import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { blue, red } from "socket-function/src/formatting/logColors";
import {
    BaseBulkDatabaseReader,
    ColumnIndex,
    assemblePlannedFile,
    columnIndexByteLength,
    KEY_COLUMN,
    TARGET_FILE_BYTES,
    TYPE_ABSENT_TAG,
} from "./BulkDatabaseFormat";

// Default total in-flight buffer budget for the executor: how much output value-data we hold in memory at
// once. Multiple output files (≤ TARGET_FILE_BYTES each) are built together inside this budget so reading
// inputs once amortizes their I/O across several outputs. Tighter budget → more passes, less memory.
const DEFAULT_OUTPUT_BATCH_BYTES = 2 * 1024 * 1024 * 1024;

// Per-value on-disk overhead (4-byte offset entry + 1-byte type tag). Used for the partition-cut size
// estimate; the executor doesn't use it (offsets/types are sized exactly from the plan).
const PER_VALUE_OVERHEAD = 5;

function fmtBytes(n: number): string {
    if (n < 1024) return n + "B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + "GB";
}

// A contiguous copy operation: take `sourceEndRow - sourceStartRow` consecutive rows of one source
// column, splice the resulting bytes into the output column's data section at outputByteStart. Adjacent
// per-row decisions get RLE'd into one copy op — one source-side read + memcpy instead of one per row.
type CopyRun = {
    sourceIdx: number;
    sourceStartRow: number;
    sourceEndRow: number;
    outputByteStart: number;
    byteLength: number;
};

type PlannedOutputColumn = {
    name: string;
    // offsets[i]..offsets[i+1] = row i's value byte range in the column's data section. Populated by the
    // planner; the executor writes it verbatim into the output column blob.
    offsets: Uint32Array;
    // Per-row type tag (TYPE_ABSENT for fall-through). Populated by the planner.
    types: Uint8Array;
    // Total bytes the data section will occupy = offsets[rowCount].
    dataLength: number;
    // Run-length encoded per-row copy decisions, in output row order. ABSENT rows contribute no run.
    runs: CopyRun[];
};

export type PlannedOutputFile = {
    keys: string[];
    times: number[];
    minKey: string;
    maxKey: string;
    columns: PlannedOutputColumn[];
    // Sum of all column data sizes + index overhead + header guess; used to group outputs into batches.
    estimatedFileBytes: number;
    // sourceIdx → non-ABSENT cell count contributed to this output file (for logging "where it came from").
    sourceCounts: Map<number, number>;
};

export type PlannedMergeOutput = {
    name: string;
    minKey: string;
    maxKey: string;
    rowCount: number;
    size: number;
    sources: Map<string, number>;
};

// Plan a merge over `sources` and execute it, writing one or more output files via the caller's
// `writeFile`. Two phases:
//   • Planning: load only per-column INDEXES (offsets + types — ~5 B/row, small even on 20GB
//     collections), determine the winning cell per (live key, column) by newest write-time + non-ABSENT
//     fall-through, sort keys, partition into ~targetFileBytes output files, and pre-compute each output
//     column's offsets/types arrays plus a run-length-encoded copy plan (no value data touched yet).
//   • Execute: group outputs into ~targetBatchBytes batches; per batch, allocate column blobs with
//     offsets/types already filled in, then iterate input sources copying contiguous byte runs straight
//     into the output buffers. A source with no contribution to this batch is skipped entirely.
// Returns the new output file descriptors plus any tombstones whose newest event is still a delete
// (carried forward when older files outside the merge could still hold a now-stale set for that key).
export async function runPlannedMerge(config: {
    sources: BaseBulkDatabaseReader[];
    sourceNames: string[];
    collectionName: string;
    targetFileBytes?: number;
    targetBatchBytes?: number;
    // Sink for step lines. When omitted, falls back to a blue-prefixed
    // console.log so standalone callers still get identifiable output.
    log?: (line: string) => void;
    writeFile: (data: Buffer) => Promise<{ name: string; size: number }>;
}): Promise<{ outputs: PlannedMergeOutput[]; carriedDeletes: Map<string, number> }> {
    const targetFileBytes = config.targetFileBytes ?? TARGET_FILE_BYTES;
    const targetBatchBytes = config.targetBatchBytes ?? DEFAULT_OUTPUT_BATCH_BYTES;
    const log = config.log ?? (line => console.log(`${blue(config.collectionName)} ${line}`));

    // ─────────────────────────────────────────── Phase 1: plan ───────────────────────────────────────────
    const planStart = Date.now();

    // Aggregate keyTimes + deleteTimes across all sources (max per key).
    const deleteTime = new Map<string, number>();
    const keyTime = new Map<string, number>();
    for (const src of config.sources) {
        for (const [k, t] of src.keyTimes) {
            const prev = keyTime.get(k);
            if (prev === undefined || t > prev) keyTime.set(k, t);
        }
        if (src.deleteTimes) {
            for (const [k, t] of src.deleteTimes) {
                const prev = deleteTime.get(k);
                if (prev === undefined || t > prev) deleteTime.set(k, t);
            }
        }
    }

    // Live keys (newest set strictly newer than newest delete) + tombstones to carry forward (newest
    // event is a delete and the merge doesn't include the oldest data — that's the caller's call).
    const liveKeys: string[] = [];
    for (const [k, t] of keyTime) {
        const dT = deleteTime.get(k) ?? -Infinity;
        if (t > dT) liveKeys.push(k);
    }
    const carriedDeletes = new Map<string, number>();
    for (const [k, dT] of deleteTime) {
        const sT = keyTime.get(k) ?? -Infinity;
        if (dT >= sT) carriedDeletes.set(k, dT);
    }

    // All distinct value columns (KEY_COLUMN excluded — it's added at file-assembly time). Order: first-
    // seen across sources, matching the existing builders.
    const allColumns: string[] = [];
    const seenCols = new Set<string>();
    for (const src of config.sources) {
        for (const c of src.columns) {
            if (c.column === KEY_COLUMN || seenCols.has(c.column)) continue;
            seenCols.add(c.column);
            allColumns.push(c.column);
        }
    }

    // Load every (source, column) index in parallel — small data (offsets+types), no values pulled. Each
    // index is kept for the executor too, so it can read contiguous row-ranges from the right source.
    const indexesPerSource: Map<string, ColumnIndex>[] = await Promise.all(config.sources.map(async src => {
        const map = new Map<string, ColumnIndex>();
        await Promise.all(allColumns.map(async col => {
            map.set(col, await src.getColumnIndex(col));
        }));
        return map;
    }));

    // For each live key, for each column, find the winning source: among sources that have this key, the
    // one whose keyTime is largest AND whose column-index reports non-ABSENT. Record source + sourceRow +
    // byteLen + type so the planner can size offsets and the executor can copy the bytes.
    type CellChoice = { sourceIdx: number; sourceRow: number; byteLen: number; type: number };
    const cellsPerKey = new Map<string, (CellChoice | undefined)[]>();
    for (const key of liveKeys) {
        const cells: (CellChoice | undefined)[] = new Array(allColumns.length);
        for (let ci = 0; ci < allColumns.length; ci++) {
            const col = allColumns[ci];
            let bestTime = -Infinity;
            let best: CellChoice | undefined;
            for (let si = 0; si < config.sources.length; si++) {
                const src = config.sources[si];
                const t = src.keyTimes.get(key);
                if (t === undefined) continue;
                const rowIdx = src.rowOfKey(key);
                if (rowIdx === undefined) continue;
                const idx = indexesPerSource[si].get(col);
                if (!idx) continue;
                const type = idx.types[rowIdx];
                if (type === TYPE_ABSENT_TAG) continue;
                if (t > bestTime) {
                    bestTime = t;
                    best = {
                        sourceIdx: si,
                        sourceRow: rowIdx,
                        byteLen: idx.offsets[rowIdx + 1] - idx.offsets[rowIdx],
                        type,
                    };
                }
            }
            cells[ci] = best;
        }
        cellsPerKey.set(key, cells);
    }

    // Sort live keys lexicographically so each output file is key-contiguous (tight minKey/maxKey + fast
    // single-key reads via header skip).
    liveKeys.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

    // Per-key estimated bytes for partition cutting: KEY_COLUMN cell + per value-column cell (bytes + 5B
    // overhead) + TIME_COLUMN cell. Rough — only needs to keep each output near the target.
    function keyTotalBytes(key: string): number {
        const cells = cellsPerKey.get(key)!;
        let total = key.length * 2 + PER_VALUE_OVERHEAD;
        for (const cell of cells) total += (cell ? cell.byteLen : 0) + PER_VALUE_OVERHEAD;
        total += 8 + PER_VALUE_OVERHEAD;
        return total;
    }

    // Walk sorted keys, cut each file when accumulated bytes would exceed targetFileBytes. A single key
    // larger than the target still becomes its own (oversized) file — we never split within a key.
    const fileKeyRanges: { start: number; end: number }[] = [];
    {
        let chunkStart = 0;
        let chunkBytes = 0;
        for (let i = 0; i < liveKeys.length; i++) {
            const kb = keyTotalBytes(liveKeys[i]);
            if (i > chunkStart && chunkBytes + kb > targetFileBytes) {
                fileKeyRanges.push({ start: chunkStart, end: i });
                chunkStart = i;
                chunkBytes = 0;
            }
            chunkBytes += kb;
        }
        if (liveKeys.length > chunkStart) fileKeyRanges.push({ start: chunkStart, end: liveKeys.length });
    }

    // Build per-file plans: offsets/types/copy-runs per column.
    const plans = fileKeyRanges.map(range => buildOutputPlan(range, liveKeys, cellsPerKey, allColumns, keyTime));

    const planTime = Date.now() - planStart;
    log(`mapping done — ${formatNumber(liveKeys.length)} live keys, ${plans.length} output file(s), ${formatNumber(carriedDeletes.size)} tombstones carried, in ${red(formatTime(planTime))}`);

    // ───────────────────────────────────────── Phase 2: execute ──────────────────────────────────────────
    // Group output files into batches that fit within targetBatchBytes so we read inputs once per batch
    // (and skip inputs that contribute nothing to this batch).
    const batches: PlannedOutputFile[][] = [];
    {
        let start = 0;
        while (start < plans.length) {
            let end = start + 1;
            let total = plans[start].estimatedFileBytes;
            while (end < plans.length && total + plans[end].estimatedFileBytes <= targetBatchBytes) {
                total += plans[end].estimatedFileBytes;
                end++;
            }
            batches.push(plans.slice(start, end));
            start = end;
        }
    }

    const outputs: PlannedMergeOutput[] = [];
    const execStart = Date.now();
    for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        const batchBytes = batch.reduce((a, p) => a + p.estimatedFileBytes, 0);
        log(`batch ${bi + 1}/${batches.length}: ${batch.length} output file(s), ~${fmtBytes(batchBytes)} budget`);
        const batchOutputs = await executeBatch(batch, indexesPerSource, config.sources, config.sourceNames, config.writeFile, log);
        outputs.push(...batchOutputs);
    }
    const execTime = Date.now() - execStart;
    const writtenBytes = outputs.reduce((a, o) => a + o.size, 0);
    log(`execute done — ${outputs.length} file(s), ${fmtBytes(writtenBytes)} written, in ${red(formatTime(execTime))} (plan + execute: ${red(formatTime(Date.now() - planStart))})`);

    return { outputs, carriedDeletes };
}

function buildOutputPlan(
    range: { start: number; end: number },
    liveKeys: string[],
    cellsPerKey: Map<string, ({ sourceIdx: number; sourceRow: number; byteLen: number; type: number } | undefined)[]>,
    allColumns: string[],
    keyTime: Map<string, number>,
): PlannedOutputFile {
    const keys = liveKeys.slice(range.start, range.end);
    const rowCount = keys.length;
    const times = keys.map(k => keyTime.get(k) ?? 0);
    const sourceCounts = new Map<number, number>();

    const columns: PlannedOutputColumn[] = allColumns.map((colName, ci) => {
        const offsets = new Uint32Array(rowCount + 1);
        const types = new Uint8Array(rowCount);
        const runs: CopyRun[] = [];
        let outputByte = 0;
        let currentRun: CopyRun | undefined;

        for (let i = 0; i < rowCount; i++) {
            const cell = cellsPerKey.get(keys[i])![ci];
            offsets[i] = outputByte;
            if (!cell) {
                types[i] = TYPE_ABSENT_TAG;
                // ABSENT contributes nothing to the data section and breaks any extending run.
                if (currentRun) { runs.push(currentRun); currentRun = undefined; }
                continue;
            }
            types[i] = cell.type;
            sourceCounts.set(cell.sourceIdx, (sourceCounts.get(cell.sourceIdx) ?? 0) + 1);
            // RLE: extend the current run iff the next cell is the next row of the same source (its
            // source-side bytes sit immediately after, so one read suffices) AND non-ABSENT (we never
            // landed in the break-path above).
            if (currentRun && currentRun.sourceIdx === cell.sourceIdx && currentRun.sourceEndRow === cell.sourceRow) {
                currentRun.sourceEndRow = cell.sourceRow + 1;
                currentRun.byteLength += cell.byteLen;
            } else {
                if (currentRun) runs.push(currentRun);
                currentRun = {
                    sourceIdx: cell.sourceIdx,
                    sourceStartRow: cell.sourceRow,
                    sourceEndRow: cell.sourceRow + 1,
                    outputByteStart: outputByte,
                    byteLength: cell.byteLen,
                };
            }
            outputByte += cell.byteLen;
        }
        if (currentRun) runs.push(currentRun);
        offsets[rowCount] = outputByte;

        return { name: colName, offsets, types, dataLength: outputByte, runs };
    });

    // File size estimate: KEY_COLUMN blob + value column blobs + TIME_COLUMN blob + header guess. Used to
    // batch output files; only needs to be close, not exact.
    let estimatedFileBytes = 4 + 2048;
    let keyBytes = 0;
    for (const k of keys) keyBytes += k.length * 2;
    estimatedFileBytes += columnIndexByteLength(rowCount) + keyBytes;
    for (const col of columns) estimatedFileBytes += columnIndexByteLength(rowCount) + col.dataLength;
    estimatedFileBytes += columnIndexByteLength(rowCount) + rowCount * 8;

    return {
        keys,
        times,
        minKey: keys[0] ?? "",
        maxKey: keys[rowCount - 1] ?? "",
        columns,
        estimatedFileBytes,
        sourceCounts,
    };
}

async function executeBatch(
    plans: PlannedOutputFile[],
    indexesPerSource: Map<string, ColumnIndex>[],
    sources: BaseBulkDatabaseReader[],
    sourceNames: string[],
    writeFile: (data: Buffer) => Promise<{ name: string; size: number }>,
    log: (line: string) => void,
): Promise<PlannedMergeOutput[]> {
    // Allocate one big buffer per (output file, column) — offsets + types are written immediately from
    // the plan, the data section is filled below by the per-source copy loop.
    type ColumnBuffer = { name: string; blob: Buffer; dataStart: number };
    const blobsPerFile: ColumnBuffer[][] = plans.map(plan => plan.columns.map(col => {
        const indexSize = columnIndexByteLength(col.offsets.length - 1);
        const blob = Buffer.alloc(indexSize + col.dataLength);
        for (let i = 0; i < col.offsets.length; i++) blob.writeUInt32LE(col.offsets[i], i * 4);
        blob.set(col.types, 4 * col.offsets.length);
        return { name: col.name, blob, dataStart: indexSize };
    }));

    // For each source, copy its byte runs into every output column whose plan references it. A source
    // that's not referenced by any column in this batch is skipped entirely — that's the point of the
    // batch shape: read 20GB of inputs only once for the whole pass, not once per output.
    for (let si = 0; si < sources.length; si++) {
        let contributes = false;
        for (let fi = 0; fi < plans.length && !contributes; fi++) {
            for (const col of plans[fi].columns) {
                if (col.runs.some(r => r.sourceIdx === si)) { contributes = true; break; }
            }
        }
        if (!contributes) continue;

        for (let fi = 0; fi < plans.length; fi++) {
            const plan = plans[fi];
            for (let ci = 0; ci < plan.columns.length; ci++) {
                const col = plan.columns[ci];
                const target = blobsPerFile[fi][ci];
                const colIndex = indexesPerSource[si].get(col.name);
                if (!colIndex) continue;
                for (const run of col.runs) {
                    if (run.sourceIdx !== si) continue;
                    const bytes = await colIndex.readValueBytes(run.sourceStartRow, run.sourceEndRow);
                    if (bytes.length !== run.byteLength) {
                        throw new Error(`Expected ${run.byteLength} bytes from source #${si} (${sourceNames[si]}) column ${col.name} rows [${run.sourceStartRow}, ${run.sourceEndRow}), got ${bytes.length}`);
                    }
                    bytes.copy(target.blob, target.dataStart + run.outputByteStart);
                }
            }
        }
    }

    // Assemble + write each output file in this batch.
    const outputs: PlannedMergeOutput[] = [];
    for (let fi = 0; fi < plans.length; fi++) {
        const plan = plans[fi];
        const start = Date.now();
        const valueColumns = blobsPerFile[fi].map(b => ({ name: b.name, blob: b.blob }));
        const fileBuf = assemblePlannedFile({ valueColumns, keys: plan.keys, times: plan.times });
        const { name, size } = await writeFile(fileBuf);
        const elapsed = Date.now() - start;
        const sourcesNamed = new Map<string, number>();
        for (const [si, n] of plan.sourceCounts) sourcesNamed.set(sourceNames[si], n);
        const srcText = [...sourcesNamed.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}:${formatNumber(n)}`).join(", ") || "—";
        log(`output ${name}: ${formatNumber(plan.keys.length)} rows from {${srcText}}, ${fmtBytes(size)} in ${formatTime(elapsed)}`);
        outputs.push({ name, minKey: plan.minKey, maxKey: plan.maxKey, rowCount: plan.keys.length, size, sources: sourcesNamed });
    }
    return outputs;
}
