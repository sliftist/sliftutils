import { getFileStorageNested2 } from "../FileFolderAPI";
import { observable, runInAction } from "../../render-utils/mobxTyped";
import { BulkDatabaseBase, ReactiveDeps } from "./BulkDatabaseBase";

export { BulkDatabaseBase, noopReactiveDeps, bulkDatabase2Timing } from "./BulkDatabaseBase";
export type { ReactiveDeps, StorageFactory } from "./BulkDatabaseBase";

// mobx-backed reactivity: each signal string gets its own observable box. observe() reads it (so an
// observer/autorun that calls it tracks that box) and invalidate() bumps it (so those reactions re-run).
// This reproduces the fine-grained per-key + load-version reactivity the class had when it used
// observable.map/observable.box directly, while keeping all that logic in the mobx-free base.
class MobxReactiveDeps implements ReactiveDeps {
    private boxes = new Map<string, { get(): number; set(value: number): void }>();
    private box(signal: string) {
        let box = this.boxes.get(signal);
        if (!box) {
            box = observable.box(0);
            this.boxes.set(signal, box);
        }
        return box;
    }
    observe(signal: string) {
        this.box(signal).get();
    }
    invalidate(signal: string) {
        let box = this.box(signal);
        box.set(box.get() + 1);
    }
    batch(fn: () => void) {
        runInAction(fn);
    }
}

// Backwards-compatible BulkDatabase2: the mobx-reactive flavor. All behavior lives in BulkDatabaseBase;
// this just supplies mobx reactivity and the default (getFileStorageNested2) storage backend, so the
// sync reads (getSingleFieldSync / getColumnSync) stay observable for mobx components.
export class BulkDatabase2<T extends { key: string }> extends BulkDatabaseBase<T> {
    constructor(name: string) {
        super(name, new MobxReactiveDeps(), getFileStorageNested2);
    }
}
