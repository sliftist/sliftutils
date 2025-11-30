import { SocketFunction } from "socket-function/SocketFunction";
import { SocketRegistered } from "socket-function/SocketFunctionTypes";
import { onHotReload } from "socket-function/hot/HotReloadController";
import { cache } from "socket-function/src/caching";
import { nextId } from "socket-function/src/misc";
import { MaybePromise } from "socket-function/src/types";
import { observable } from "mobx";
import { formatTime } from "socket-function/src/formatting/format";
import { isNode } from "typesafecss";
import { delay } from "socket-function/src/batching";

module.hotreload = false;

let syncedData: {
    [controllerId: string]: {
        [nodeId: string]: {
            [fnc: string]: {
                [argsHash: string]: {
                    promise: Promise<unknown> | undefined;
                    result?: { result: unknown } | { error: Error };
                    invalidated?: boolean;
                    setCacheSeqNumber: number;
                } | undefined;
            } | undefined;
        } | undefined;
    } | undefined;
} = {};
let syncedDataSeqNum = observable({
    value: 0
});

function commit<T>(code: () => T) {
    let result = code();
    syncedDataSeqNum.value++;
    return result;
}
function read<T>(code: () => T) {
    syncedDataSeqNum.value;
    return code();
}

type RemapFunction<T> = T extends (...args: infer Args) => Promise<infer Return>
    ? {
        (...args: Args): Return | undefined;
        promise(...args: Args): Promise<Return>;
        refresh(...args: Args): void;
        refreshAll(): void;
        reset(...args: Args): void;
        resetAll(): void;
        isLoading(...args: Args): boolean;
        setCache(cache: {
            args: Args;
            result: Return;
        }): void;
    }
    : T;

// key =>
const writeWatchers = new Map<string, {
    controllerId: string;
    fncName: string;
}[]>();

export function getSyncedController<T extends SocketRegistered>(
    controller: T,
    config?: {
        /** When a controller call for a write finishes, we refresh all readers.
         *      - Invalidation is global, across all controllers.
         */
        reads?: { [key in keyof T["nodes"][""]]?: string[]; };
        writes?: { [key in keyof T["nodes"][""]]?: string[]; };
    }
): {
    (nodeId: string): {
        [fnc in keyof T["nodes"][""]]: RemapFunction<T["nodes"][""][fnc]>;
    } & {
        resetAll(): void;
        refreshAll(): void;
        anyPending(): boolean;
    };
    resetAll(): void;
    refreshAll(): void;
    anyPending(): boolean;
    rerenderAll(): void;
} {
    if (isNode()) {
        let result = cache((nodeId: string) => {
            let proxy = new Proxy({}, {
                get: (target, fncNameUntyped) => {
                    if (typeof fncNameUntyped !== "string") return undefined;
                    if (fncNameUntyped === "resetAll" || fncNameUntyped === "refreshAll" || fncNameUntyped === "isAnyLoading") {
                        return notAllowedOnServer;
                    }
                    let fncName = fncNameUntyped;
                    function call(...args: any[]) {
                        notAllowedOnServer();
                    }
                    call.promise = (...args: any[]) => {
                        return controller.nodes[nodeId][fncName](...args);
                    };
                    call.reset = (...args: any[]) => {
                        notAllowedOnServer();
                    };
                    call.resetAll = () => {
                        notAllowedOnServer();
                    };
                    call.refresh = (...args: any[]) => {
                        notAllowedOnServer();
                    };
                    call.refreshAll = () => {
                        notAllowedOnServer();
                    };
                    call.isAnyLoading = () => {
                        notAllowedOnServer();
                    };
                    call.setCache = (config: { args: any[], result: any }) => {
                        notAllowedOnServer();
                    };
                    return call;
                }
            }) as any;
            return proxy;
        }) as any;
        function notAllowedOnServer() {
            throw new Error(`Syncing with getSyncedController is not allowed on the server. You can call promise, but not the synced functions.`);
        }
        result.resetAll = () => {
            notAllowedOnServer();
        };
        result.refreshAll = () => {
            notAllowedOnServer();
        };
        result.isAnyLoading = () => {
            notAllowedOnServer();
        };
        return result;
    }
    let controllerId = nextId();

    for (let [fncName, keys] of Object.entries(config?.reads ?? {})) {
        for (let key of keys || []) {
            let watcherList = writeWatchers.get(key);
            if (!watcherList) {
                watcherList = [];
                writeWatchers.set(key, watcherList);
            }
            watcherList.push({ controllerId, fncName });
        }
    }

    let result = cache((nodeId: string) => {
        SocketFunction.onNextDisconnect(nodeId, () => {
            commit(() => {
                delete syncedData[controllerId]?.[nodeId];
            });
        });
        return new Proxy({}, {
            get: (target, fncNameUntyped) => {
                if (typeof fncNameUntyped !== "string") return undefined;
                if (fncNameUntyped === "resetAll") {
                    return () => {
                        return commit(() => {
                            delete syncedData[controllerId]?.[nodeId];
                        });
                    };
                }
                if (fncNameUntyped === "refreshAll") {
                    return () => {
                        return commit(() => {
                            let nodeObj = syncedData[controllerId]?.[nodeId];
                            if (!nodeObj) return;
                            for (let fncObj of Object.values(nodeObj)) {
                                for (let argsHash in fncObj) {
                                    let obj = fncObj[argsHash];
                                    if (!obj) continue;
                                    obj.invalidated = true;
                                }
                            }
                        });
                    };
                }
                if (fncNameUntyped === "anyPending") {
                    return () => {
                        return read(() => {
                            let nodeObj = syncedData[controllerId]?.[nodeId];
                            if (!nodeObj) return false;
                            for (let fncObj of Object.values(nodeObj)) {
                                for (let argsHash in fncObj) {
                                    let obj = fncObj[argsHash];
                                    if (!obj) continue;
                                    if (obj.promise) return true;
                                }
                            }
                            return false;
                        });
                    };
                }
                let fncName = fncNameUntyped;
                function getObj(...args: any[]) {
                    let argsHash = JSON.stringify(args);
                    let controllerObj = syncedData[controllerId];
                    if (!controllerObj) {
                        controllerObj = syncedData[controllerId] = {};
                    }
                    let nodeObj = controllerObj[nodeId];
                    if (!nodeObj) {
                        nodeObj = controllerObj[nodeId] = {};
                    }
                    let fncObj = nodeObj[fncName];
                    if (!fncObj) {
                        fncObj = nodeObj[fncName] = {};
                    }
                    let obj = fncObj[argsHash];
                    if (!obj) {
                        obj = fncObj[argsHash] = {
                            promise: undefined,
                            result: undefined,
                            setCacheSeqNumber: 0,
                        };
                    }
                    return obj;
                }
                function call(...args: any[]) {
                    return read(() => {
                        let obj = getObj(...args);

                        if (!obj.promise && (!obj.result || obj.invalidated)) {
                            obj.invalidated = false;
                            let time = Date.now();
                            let finished = false;
                            function logFinished() {
                                finished = true;
                                let duration = Date.now() - time;
                                if (duration > 500) {
                                    console.warn(`Slow call ${fncName} took ${formatTime(duration)}`);
                                }
                            }
                            let promise = controller.nodes[nodeId][fncName](...args) as Promise<unknown>;
                            obj.promise = promise;
                            function invalidateReaders() {
                                let root = syncedData;
                                for (let writesTo of config?.writes?.[fncName] || []) {
                                    for (let watcher of writeWatchers.get(writesTo) || []) {
                                        for (let nodeObj of Object.values(root[watcher.controllerId] ?? {})) {
                                            for (let fncObj of Object.values(nodeObj || {})) {
                                                for (let obj of Object.values(fncObj || {})) {
                                                    if (!obj) continue;
                                                    obj.invalidated = true;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            let setCacheSeqNumber = obj.setCacheSeqNumber;
                            // Run a loop warning every 10 seconds that the call is still pending until it's finished. 
                            void (async () => {
                                while (true) {
                                    await delay(10000);
                                    if (finished) break;
                                    console.warn(`Slow call, running for ${formatTime(Date.now() - time)}: ${fncName}`);
                                }
                            })();
                            promise.then(
                                result => {
                                    invalidateReaders();
                                    logFinished();
                                    commit(() => {
                                        obj.promise = undefined;
                                        if (obj.setCacheSeqNumber === setCacheSeqNumber) {
                                            obj.result = { result };
                                        }
                                    });
                                },
                                error => {
                                    invalidateReaders();
                                    logFinished();
                                    commit(() => {
                                        obj.promise = undefined;
                                        if (obj.setCacheSeqNumber === setCacheSeqNumber) {
                                            obj.result = { error };
                                        }
                                    });
                                }
                            );
                        }

                        let result = obj.result;
                        if (result) {
                            if ("error" in result) {
                                throw result.error;
                            } else {
                                return result.result;
                            }
                        }
                        return undefined;
                    });
                }
                call.promise = (...args: any[]) => {
                    let obj = getObj(...args);
                    // Reset promise, to force it to not use the cache, as promise functions should never be cached. This might result in the results being set out of order, but... generally functions called with promise and accessed inside a watcher, so this should be fine.
                    obj.promise = undefined;
                    obj.invalidated = true;
                    call(...args);
                    if (!obj.promise) {
                        debugger;
                        throw new Error("Promise is undefined after calling function?");
                    }
                    // Reset typeguards, as typescript doesn't think call will change obj.promise
                    obj = obj as any;
                    let promise = obj.promise;
                    void promise?.finally(() => {
                        // Don't cache it, we never want to cache pure promise calls.
                        if (promise === obj.promise) {
                            obj.promise = undefined;
                        }
                    });
                    return obj.promise;
                };
                call.reset = (...args: any[]) => {
                    return commit(() => {
                        let argsHash = JSON.stringify(args);
                        let obj = syncedData[controllerId]?.[nodeId]?.[fncName]?.[argsHash];
                        if (!obj) return;
                        delete obj.promise;
                        delete obj.result;
                    });
                };
                call.resetAll = () => {
                    return commit(() => {
                        delete syncedData[controllerId]?.[nodeId]?.[fncName];
                    });
                };
                call.refresh = (...args: any[]) => {
                    return commit(() => {
                        let argsHash = JSON.stringify(args);
                        let obj = syncedData[controllerId]?.[nodeId]?.[fncName]?.[argsHash];
                        if (!obj) return;
                        obj.invalidated = true;
                    });
                };
                call.refreshAll = () => {
                    return commit(() => {
                        delete syncedData[controllerId]?.[nodeId]?.[fncName];
                    });
                };
                call.isLoading = (...args: any[]) => {
                    return read(() => {
                        let argsHash = JSON.stringify(args);
                        let obj = syncedData[controllerId]?.[nodeId]?.[fncName]?.[argsHash];
                        return !!obj?.promise;
                    });
                };
                call.setCache = (cache: {
                    args: any[];
                    result: unknown;
                }) => {
                    return commit(() => {
                        let obj = getObj(...cache.args);
                        obj.result = { result: cache.result };
                        obj.promise = undefined;
                        obj.setCacheSeqNumber++;
                    });
                };
                return call;
            },
        });
    }) as any;
    result.resetAll = () => {
        return commit(() => {
            delete syncedData[controllerId];
        });
    };
    result.refreshAll = () => {
        return commit(() => {
            for (let node of Object.values(syncedData[controllerId] ?? {})) {
                for (let fncObj of Object.values(node || {})) {
                    for (let obj of Object.values(fncObj || {})) {
                        if (!obj) continue;
                        obj.invalidated = true;
                    }
                }
            }
        });
    };
    result.anyPending = () => {
        return read(() => {
            if (!syncedData[controllerId]) return false;
            for (let node of Object.values(syncedData[controllerId] ?? {})) {
                for (let fncObj of Object.values(node || {})) {
                    for (let obj of Object.values(fncObj || {})) {
                        if (!obj) continue;
                        if (obj.promise) return true;
                    }
                }
            }
            return false;
        });
    };
    result.rerenderAll = () => {
        return commit(() => {
        });
    };
    return result;
}