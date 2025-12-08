import { isNode } from "typesafecss";
import { observable } from "mobx";
import { throttleFunction } from "socket-function/src/misc";
import { niceParse, niceStringify } from "./niceStringify";

let urlParamLookup = new Map<string, URLParam<unknown>>();
let pauseUpdate = false;

export class URLParam<T = unknown> {
    constructor(public readonly key: string, private defaultValue: T = "" as any) {
        urlParamLookup.set(key, this);
    }
    valueSeqNum = observable({ value: 1 });
    public get(): T {
        urlBackSeqNum.value;
        this.valueSeqNum.value;
        let value = new URL(getCurrentUrl()).searchParams.get(this.key);
        if (value === null) {
            return this.defaultValue;
        }
        return niceParse(value) as T;
    }
    public set(value: T) {
        let url = new URL(getCurrentUrl());
        if (value === this.defaultValue) {
            url.searchParams.delete(this.key);
        } else {
            url.searchParams.set(this.key, niceStringify(value));
        }
        if (!pauseUpdate) {
            void throttledUrlPush(url.toString());
            this.valueSeqNum.value++;
        }
    }
    public reset() {
        let url = new URL(getCurrentUrl());
        url.searchParams.delete(this.key);
        if (!pauseUpdate) {
            void throttledUrlPush(url.toString());
            this.valueSeqNum.value++;
        }
    }

    public getOverride(value: T): [string, string] {
        return [this.key, value as any];
    }

    public get value() {
        return this.get();
    }
    public set value(value: T) {
        this.set(value);
    }
}

export function getResolvedParam(param: [URLParam, unknown] | [string, string]): [string, string] {
    if (typeof param[0] === "string") {
        return [param[0], niceStringify(param[1])];
    }
    return [param[0].key, niceStringify(param[1])];
}
export function batchURLParamUpdate(params: ([URLParam, unknown] | [string, string])[]) {
    let resolvedParams = params.map(getResolvedParam);
    pauseUpdate = true;
    let url = new URL(location.href);
    try {
        for (let [key, value] of resolvedParams) {
            url.searchParams.set(key, value);
            let urlParam = urlParamLookup.get(key);
            urlParam?.set(niceParse(value));
        }
    } finally {
        pauseUpdate = false;
    }
    urlBackSeqNum.value++;
    void throttledUrlPush(url.toString());
}

export function getCurrentUrl() {
    return currentBatchedUrl ?? location.href;
}


let currentBatchedUrl: string | undefined;
function throttledUrlPush(url: string) {
    history.pushState({}, "", url);
    //currentBatchedUrl = url;
    // NOTE: Stopped throttling, so when you click on links, it immediately updates the selected state. 
    //void throttledUrlPushBase(url);
}
const throttledUrlPushBase = throttleFunction(1000, (url: string) => {
    currentBatchedUrl = undefined;
    history.pushState({}, "", url);
});

let urlBackSeqNum = observable({ value: 1 });
if (!isNode()) {
    window.addEventListener("popstate", () => {
        urlBackSeqNum.value++;
    });
}