process.env.NODE_ENV = "production";

import { isNode } from "typesafecss";
import { observable } from "mobx";
import { throttleFunction } from "socket-function/src/misc";
import { createSingleton } from "socket-function/src/createSingleton";
import { niceParse, niceStringify } from "./niceStringify";

const shared = createSingleton("sliftutils.URLParam", 1, () => ({
    urlParamLookup: new Map<string, URLParam<unknown>>(),
    allURLParams: new Set<URLParam<unknown>>(),
    tickCacheClearScheduled: false,
    urlBackSeqNum: observable({ value: 1 }),
    popstateListenerAdded: false,
})).get();
const urlParamLookup = shared.urlParamLookup;
const urlBackSeqNum = shared.urlBackSeqNum;
let pauseUpdate = false;

function clearAllTickCaches() {
    for (const param of shared.allURLParams) {
        param.clearTickCache();
    }
}
function scheduleTickCacheClear() {
    if (shared.tickCacheClearScheduled) return;
    shared.tickCacheClearScheduled = true;
    setTimeout(() => {
        shared.tickCacheClearScheduled = false;
        clearAllTickCaches();
    }, 0);
}

export class URLParam<T = unknown> {
    constructor(public readonly key: string, private defaultValue: T = "" as any) {
        urlParamLookup.set(key, this);
        shared.allURLParams.add(this);
    }
    valueSeqNum = observable({ value: 1 });
    private tickCache: { value: T } | undefined;
    private setTickCache(value: T) {
        this.tickCache = { value };
        scheduleTickCacheClear();
    }
    public clearTickCache() {
        this.tickCache = undefined;
    }
    public get(): T {
        urlBackSeqNum.value;
        this.valueSeqNum.value;
        if (this.tickCache) {
            return this.tickCache.value;
        }
        let rawValue = new URL(getCurrentUrl()).searchParams.get(this.key);
        let value = this.defaultValue;
        if (rawValue !== null) {
            value = niceParse(rawValue) as T;
        }
        this.setTickCache(value);
        return value;
    }
    public set(value: T) {
        let url = new URL(getCurrentUrl());
        if (value === this.defaultValue) {
            url.searchParams.delete(this.key);
        } else {
            url.searchParams.set(this.key, niceStringify(value));
        }
        this.setTickCache(value);
        if (!pauseUpdate) {
            void throttledUrlPush(url.toString());
            this.valueSeqNum.value++;
        }
    }
    public reset() {
        let url = new URL(getCurrentUrl());
        url.searchParams.delete(this.key);
        this.setTickCache(this.defaultValue);
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
    // currentBatchedUrl = url;
    // NOTE: Stopped throttling, so when you click on links, it immediately updates the selected state. void throttledUrlPushBase(url);
}
const throttledUrlPushBase = throttleFunction(1000, (url: string) => {
    currentBatchedUrl = undefined;
    history.pushState({}, "", url);
});

if (!isNode() && !shared.popstateListenerAdded) {
    shared.popstateListenerAdded = true;
    window.addEventListener("popstate", () => {
        clearAllTickCaches();
        urlBackSeqNum.value++;
    });
}