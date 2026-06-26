import type { FileStorage } from "../FileFolderAPI";
export type DeleteMarker = {
    fileName: string;
    deleteFiles: string[];
    replacedBy: string[];
    time: number;
};
export declare function isMarkerFile(name: string): boolean;
export declare function writeDeleteMarker(storage: FileStorage, config: {
    deleteFiles: string[];
    replacedBy: string[];
}): Promise<void>;
export declare function readDeleteMarkers(storage: FileStorage, allNames: string[]): Promise<DeleteMarker[]>;
export declare function markerExclusions(markers: DeleteMarker[]): Set<string>;
export declare function processDeleteMarkers(storage: FileStorage, markers: DeleteMarker[], allNames: string[]): Promise<void>;
