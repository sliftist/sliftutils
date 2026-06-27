// undefined from a read means "not synced yet", NOT "absent" — storage initializes on its own. So read everything a stage needs in one readData and bail if the whole result is undefined; the database never returns an individual unsynced value inside an otherwise-successful read.
export interface Database<Root> {
    readData: <Value>(deref: (root: Root) => Value) => Value | undefined;
    writeData: <Value>(deref: (root: Root) => Value, newValue: Value) => void;
    deleteData: (deref: (root: Root) => unknown) => void;
}

export function namespaceDatabase<Root, Sub>(
    database: Database<Root>,
    into: (root: Root) => Sub,
): Database<Sub> {
    return {
        readData: (deref) => database.readData(root => deref(into(root))),
        writeData: (deref, newValue) => database.writeData(root => deref(into(root)), newValue),
        deleteData: (deref) => database.deleteData(root => deref(into(root))),
    };
}
