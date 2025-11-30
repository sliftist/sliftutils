import { isNode } from "typesafecss";
import { observable } from "mobx";

let allParams: LocalStorageParamStr[] = [];

export class LocalStorageParamStr {
    private state = observable({
        seqNum: 0
    });
    public lastSetValue = "";
    constructor(public readonly storageKey: string, private defaultValue: string = "") {
        allParams.push(this);
    }
    public forceUpdate() {
        this.state.seqNum++;
    }

    public get() {
        this.state.seqNum;
        if (isNode()) return "";
        return localStorage.getItem(this.storageKey) || "";
    }
    public set(value: string) {
        let prev = this.get();
        this.lastSetValue = value;
        if (!isNode()) {
            if (value === "") {
                localStorage.removeItem(this.storageKey);
            } else {
                localStorage.setItem(this.storageKey, value);
            }
        }
        let after = this.get();
        if (prev !== after) {
            this.state.seqNum++;
        }
    }

    public get value() {
        return this.get() || this.defaultValue;
    }
    public set value(value: string) {
        this.set(value);
    }
}

if (!isNode()) {
    // Watch for storage events from other tabs/windows
    window.addEventListener("storage", (e) => {
        for (let param of allParams) {
            if (e.key === param.storageKey) {
                param.forceUpdate();
            }
        }
    });
}
