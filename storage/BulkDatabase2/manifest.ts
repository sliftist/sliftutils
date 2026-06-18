// A manifest records which bulk files are valid, decoupling "a file exists on disk" from "a file is
// part of the database." Every operation that changes the bulk layout (rollover, merge, direct write)
// writes a brand-new manifest instead of mutating/deleting in place, so changes are atomic from a
// reader's point of view: a reader sees either the old manifest or the new one, never a half-applied
// state. Manifests are immutable once written and never clobbered.
//
// Resolution: read every manifest, pick the one with the newest startTime (the time its writer
// snapshotted the directory). The latest starter has the most up-to-date view, so its decision wins;
// an older-starting writer that finishes later is ignored, and its freshly-written files are simply
// orphaned (cleaned up later) — its inputs were never marked consumed, so no data is lost.
//
// Back-compat: if there is no manifest at all, every bulk file is valid (old databases just work).
// Stream files are always valid unless a manifest lists them as already merged into a bulk file
// (ignoredStreamFiles); they carry their own per-write timestamps, so they self-resolve regardless.

export const MANIFEST_EXTENSION = ".manifest";

export type Manifest = {
    // When the writer snapshotted the directory (its read time). Newest startTime wins.
    startTime: number;
    // The full set of bulk files that are valid as of this manifest (not a delta).
    validBulkFiles: string[];
    // Stream files already folded into a bulk file — ignore them on read; cleanup deletes them later.
    ignoredStreamFiles: string[];
    // The filenames the writer saw at startTime (diagnostics + lets cleanup reason about what existed).
    readFiles: string[];
};

export function isManifestName(name: string): boolean {
    return name.endsWith(MANIFEST_EXTENSION);
}

// manifest_<startTime>_<writerId>_<counter>.manifest — writerId keeps two processes from colliding on
// a name when they start in the same millisecond.
export function manifestFileName(startTime: number, writerId: string, counter: number): string {
    return `manifest_${startTime}_${writerId}_${counter}${MANIFEST_EXTENSION}`;
}

export function parseManifestStartTime(name: string): number | undefined {
    if (!name.endsWith(MANIFEST_EXTENSION)) return undefined;
    const parts = name.slice(0, -MANIFEST_EXTENSION.length).split("_");
    if (parts[0] !== "manifest") return undefined;
    const startTime = parseInt(parts[1], 10);
    return Number.isFinite(startTime) ? startTime : undefined;
}

// Picks the authoritative manifest: newest startTime, ties broken by name for determinism. Returns
// undefined if there are none (callers then treat every bulk file as valid).
export function chooseManifest(manifests: { name: string; manifest: Manifest }[]): { name: string; manifest: Manifest } | undefined {
    let chosen: { name: string; manifest: Manifest } | undefined;
    for (const entry of manifests) {
        if (!chosen
            || entry.manifest.startTime > chosen.manifest.startTime
            || (entry.manifest.startTime === chosen.manifest.startTime && entry.name > chosen.name)) {
            chosen = entry;
        }
    }
    return chosen;
}
