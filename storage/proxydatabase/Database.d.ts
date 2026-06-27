export interface Database<Root> {
    readData: <Value>(deref: (root: Root) => Value) => Value | undefined;
    writeData: <Value>(deref: (root: Root) => Value, newValue: Value) => void;
    deleteData: (deref: (root: Root) => unknown) => void;
}
export declare function namespaceDatabase<Root, Sub>(database: Database<Root>, into: (root: Root) => Sub): Database<Sub>;
