import { isNode } from "typesafecss";
import { observable } from "mobx";

let allParams: URLParamStr[] = [];

let updated: URLParamStr[] = [];

export class URLParamStr {
    private state = observable({
        seqNum: 0
    });
    public lastSetValue = "";
    constructor(public readonly urlKey: string) {
        allParams.push(this);
    }
    public forceUpdate() {
        this.state.seqNum++;
    }

    public get() {
        this.state.seqNum;
        return new URLSearchParams(window.location.search).get(this.urlKey) || "";
    }
    public set(value: string) {
        if (value === this.get()) return;
        this.lastSetValue = value;
        batchUrlUpdate(() => {
            updated.push(this);
        });
        this.state.seqNum++;
    }

    public get value() {
        return this.get();
    }
    public set value(value: string) {
        this.set(value);
    }
}

let inBatchUpdate = false;
export function batchUrlUpdate<T>(code: () => T): T {
    if (inBatchUpdate) return code();
    inBatchUpdate = true;
    try {
        return code();
    } finally {
        inBatchUpdate = false;

        let prevUpdated = updated;
        updated = [];
        let searchParams = new URLSearchParams(window.location.search);
        for (let obj of prevUpdated) {
            searchParams.set(obj.urlKey, obj.lastSetValue);
        }
        let newURL = "?" + searchParams.toString();
        if (window.location.hash) {
            newURL += window.location.hash;
        }
        window.history.pushState({}, "", newURL);
    }
}

export function createLink(params: [URLParamStr, string][]) {
    let searchParams = new URLSearchParams(window.location.search);
    for (let [param, value] of params) {
        searchParams.set(param.urlKey, value);
    }
    let newURL = "?" + searchParams.toString();
    if (window.location.hash) {
        newURL += window.location.hash;
    }
    return newURL;
}

if (!isNode()) {
    // Watch for url push states
    window.addEventListener("popstate", () => {
        // Force all to update, in case their param changed
        for (let param of allParams) {
            param.forceUpdate();
        }
    });
}