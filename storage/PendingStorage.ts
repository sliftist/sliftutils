import { throttleFunction } from "socket-function/src/misc";
import { IStorage } from "./IStorage";
import { setPending } from "./PendingManager";

export class PendingStorage<T> implements IStorage<T> {
    pending = new Map<string, number>();
    constructor(
        private pendingGroup: string,
        private storage: IStorage<T>,
    ) { }
    public async get(key: string): Promise<T | undefined> {
        return this.watchPending("get", this.storage.get(key));
    }
    public async set(key: string, value: T): Promise<void> {
        return this.watchPending("set", this.storage.set(key, value));
    }
    public async remove(key: string): Promise<void> {
        return this.watchPending("remove", this.storage.remove(key));
    }
    public async getKeys(): Promise<string[]> {
        return this.watchPending("getKeys", this.storage.getKeys());
    }
    public async getInfo(key: string) {
        return this.watchPending("getInfo", this.storage.getInfo(key));
    }

    private watchPending<T>(type: string, promise: Promise<T>): Promise<T> {
        this.pending.set(type, (this.pending.get(type) || 0) + 1);
        void this.updatePending();
        void promise.finally(() => {
            this.pending.set(type, (this.pending.get(type) || 0) - 1);
            if (this.pending.get(type) === 0) {
                this.pending.delete(type);
            }
            void this.updatePending();
        });
        return promise;
    }
    private updatePending = throttleFunction(100, () => {
        let text = Array.from(this.pending.entries()).map(([key, value]) => `${key}: ${value}`).join(", ");
        setPending(this.pendingGroup, text);
    });

    public async reset() {
        return this.storage.reset();
    }
}