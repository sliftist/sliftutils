import { Database } from "./Database";
export declare class InMemoryDatabase<Root> implements Database<Root> {
    readCalls: number;
    writeCalls: number;
    deleteCalls: number;
    bytesRead: number;
    bytesWritten: number;
    private root;
    constructor(initial: Root);
    readData<Value>(deref: (root: Root) => Value): Value | undefined;
    writeData<Value>(deref: (root: Root) => Value, newValue: Value): void;
    deleteData(deref: (root: Root) => unknown): void;
}
