process.env.NODE_ENV = "production";

import { observable, runInAction, computed, autorun, onBecomeObserved, onBecomeUnobserved, Reaction, configure } from "mobx";
import { setFlag } from "socket-function/require/compileFlags";
import { batchFunction } from "socket-function/src/batching";

// Re-export the core mobx primitives so downstream packages (which may have their own duplicate mobx in node_modules) can share THIS mobx instance, otherwise reactivity doesn't cross package boundaries.
export { observable, runInAction, computed, autorun, onBecomeObserved, onBecomeUnobserved, Reaction };
setFlag(require, "mobx", "allowclient", true);
export function configureMobxNextFrameScheduler() {
    // NOTE: This makes a big difference if we do await calls in a loop which mutates observable state. BUT... we should probably just do those await calls before the loop?
    let batchReactionScheduler = batchFunction({
        delay: 16,
        name: "reactionScheduler",
    }, (callbacks: (() => void)[]) => {
        // console.log(`Triggering ${callbacks.length} reactions`);
        for (let callback of callbacks) {
            callback();
        }
        lastRenderTime = Date.now();
    });

    let lastRenderTime = 0;
    configure({
        enforceActions: "never",
        reactionScheduler(callback) {
            let now = performance.now();
            if (now - lastRenderTime < 16) {
                void batchReactionScheduler(callback);
            } else {
                callback();
                lastRenderTime = now;
            }
        }
    });
}
