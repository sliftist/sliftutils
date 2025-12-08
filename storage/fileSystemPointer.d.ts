export type FileSystemPointer = string;
export declare function storeFileSystemPointer(config: {
    mode: "read" | "readwrite";
    handle: FileSystemFileHandle | FileSystemDirectoryHandle;
}): Promise<FileSystemPointer>;
export declare function deleteFileSystemPointer(pointer: FileSystemPointer): Promise<void>;
export declare function getFileSystemPointer(config: {
    pointer: FileSystemPointer;
}): Promise<{
    onUserActivation(modeOverride?: "read" | "readwrite"): Promise<FileSystemFileHandle | FileSystemDirectoryHandle>;
} | undefined>;
