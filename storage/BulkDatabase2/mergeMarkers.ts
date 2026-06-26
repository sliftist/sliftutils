// Deletion markers: how a merge retires the input files it consumed WITHOUT deleting them inline.
//
// The old approach deleted consumed inputs on a 15-min timer. If the tab closed before the timer fired
// the inputs survived AND were still read — so the next merge re-merged the same duplicates, forever
// (the "1739 files, 155GB, 99% duplicate" loop). Markers fix both halves: the consumed inputs are
// EXCLUDED from reads the moment the marker exists (so they're never re-merged), and their physical
// deletion is driven off the marker on a later read instead of an in-process timer.
//
// A marker names the input files it wants gone (`deleteFiles`) and the output files that supersede them
// (`replacedBy`). On every read we:
//   1) exclude every `deleteFiles` entry from the active file set (unconditionally — that's the loop fix);
//   2) delete a marker's `deleteFiles` once its `replacedBy` outputs all exist OR the marker is older than
//      the grace window (a crash-safety floor so a marker whose outputs never landed still gets cleaned);
//   3) once a marker's `deleteFiles` are all gone, and the marker has aged past the grace window, delete
//      the marker itself (kept around briefly so a concurrent reader still excludes the files consistently).

import type { FileStorage } from "../FileFolderAPI";

const MARKER_PREFIX = ".delete-marker_";
const MARKER_GRACE_MS = 5 * 60 * 1000;

export type DeleteMarker = {
    fileName: string;
    deleteFiles: string[];
    replacedBy: string[];
    time: number;
};

export function isMarkerFile(name: string): boolean {
    return name.startsWith(MARKER_PREFIX);
}

export async function writeDeleteMarker(storage: FileStorage, config: { deleteFiles: string[]; replacedBy: string[] }): Promise<void> {
    const time = Date.now();
    const name = `${MARKER_PREFIX}${time}_${Math.random().toString(36).slice(2, 10)}`;
    const body = JSON.stringify({ deleteFiles: config.deleteFiles, replacedBy: config.replacedBy, time });
    await storage.set(name, Buffer.from(body, "utf8") as Buffer);
}

export async function readDeleteMarkers(storage: FileStorage, allNames: string[]): Promise<DeleteMarker[]> {
    const markerNames = allNames.filter(isMarkerFile);
    const markers = await Promise.all(markerNames.map(async (fileName): Promise<DeleteMarker | undefined> => {
        try {
            const buf = await storage.get(fileName);
            if (!buf) return undefined;
            const parsed = JSON.parse(buf.toString("utf8")) as { deleteFiles?: unknown; replacedBy?: unknown; time?: unknown };
            if (!Array.isArray(parsed.deleteFiles) || !Array.isArray(parsed.replacedBy)) return undefined;
            return {
                fileName,
                deleteFiles: parsed.deleteFiles as string[],
                replacedBy: parsed.replacedBy as string[],
                time: typeof parsed.time === "number" ? parsed.time : 0,
            };
        } catch {
            return undefined;
        }
    }));
    return markers.filter((m): m is DeleteMarker => !!m);
}

// The set of files that any marker wants deleted — these must be dropped from the active read set.
export function markerExclusions(markers: DeleteMarker[]): Set<string> {
    const excluded = new Set<string>();
    for (const m of markers) for (const n of m.deleteFiles) excluded.add(n);
    return excluded;
}

// Act on each marker (see file header). Idempotent and best-effort: every removal is guarded, so two
// processes (or two reads) running this at once just race to the same already-correct end state.
export async function processDeleteMarkers(storage: FileStorage, markers: DeleteMarker[], allNames: string[]): Promise<void> {
    const present = new Set(allNames);
    const now = Date.now();
    for (const marker of markers) {
        const stillPresent = marker.deleteFiles.filter(n => present.has(n));
        if (!stillPresent.length) {
            // The files this marker retired are gone; once it's aged past the grace window, retire the marker too.
            if (now - marker.time > MARKER_GRACE_MS) {
                try { await storage.remove(marker.fileName); } catch { /* already gone */ }
            }
            continue;
        }
        const replacedExists = marker.replacedBy.length > 0 && marker.replacedBy.every(n => present.has(n));
        if (replacedExists || now - marker.time > MARKER_GRACE_MS) {
            for (const n of stillPresent) {
                try { await storage.remove(n); } catch { /* already gone */ }
            }
        }
    }
}
