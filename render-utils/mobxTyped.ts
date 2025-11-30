import * as mobx from "mobx";
import { batchFunction } from "socket-function/src/batching";
export function configureMobxNextFrameScheduler() {
    // NOTE: This makes a big difference if we do await calls in a loop which mutates observable state. BUT... we should probably just do those await calls before the loop?
    let batchReactionScheduler = batchFunction({
        delay: 16,
        name: "reactionScheduler",
    }, (callbacks: (() => void)[]) => {
        //console.log(`Triggering ${callbacks.length} reactions`);
        for (let callback of callbacks) {
            callback();
        }
        lastRenderTime = Date.now();
    });

    let lastRenderTime = 0;
    mobx.configure({
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
