// A type-safe handle to an externally-owned reactive/sync database. You read and
// write by passing a dereference lambda from a pseudo `Root` object down to the
// value you want.
//
// undefined from readData means "not synchronized yet" — NOT "absent". There is
// no separate initialization step; storage materializes automatically. So the
// standard pattern is to read everything a stage needs in ONE readData (returning
// an aggregate), and if the whole read is undefined, no-op and let the caller's
// retry wrapper re-run once more data has synced. The database never hands back an
// individual unsynced value inside an otherwise-successful read (e.g. Object.values
// only yields synced entries), so callers check the top-level result, not each leaf.
export interface Database<Root> {
    readData: <Value>(deref: (root: Root) => Value) => Value | undefined;
    writeData: <Value>(deref: (root: Root) => Value, newValue: Value) => void;
    deleteData: (deref: (root: Root) => unknown) => void;
}

// Re-root a database at a sub-path, so a component (e.g. one transaction set) gets
// a Database typed to exactly its slice and just reads/writes from there. The
// dereference lambdas compose: every access is rewritten through `into`.
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
