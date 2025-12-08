import { FileStorage } from "./FileFolderAPI";
export declare const getFileStorageIndexDB: {
    (): Promise<FileStorage>;
    reset(): void;
    set(newValue: Promise<FileStorage>): void;
};
