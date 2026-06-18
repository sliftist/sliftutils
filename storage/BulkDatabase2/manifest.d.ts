export declare const MANIFEST_EXTENSION = ".manifest";
export type Manifest = {
    startTime: number;
    validBulkFiles: string[];
    ignoredStreamFiles: string[];
    readFiles: string[];
};
export declare function isManifestName(name: string): boolean;
export declare function manifestFileName(startTime: number, writerId: string, counter: number): string;
export declare function parseManifestStartTime(name: string): number | undefined;
export declare function chooseManifest(manifests: {
    name: string;
    manifest: Manifest;
}[]): {
    name: string;
    manifest: Manifest;
} | undefined;
