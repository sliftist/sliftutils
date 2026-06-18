import { BulkDatabaseBase } from "./BulkDatabaseBase";
export { BulkDatabaseBase, noopReactiveDeps } from "./BulkDatabaseBase";
export type { ReactiveDeps, StorageFactory } from "./BulkDatabaseBase";
export declare class BulkDatabase2<T extends {
    key: string;
}> extends BulkDatabaseBase<T> {
    constructor(name: string);
}
