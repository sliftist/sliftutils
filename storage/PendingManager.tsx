import { throttleFunction } from "socket-function/src/misc";
import { observable } from "mobx";
import preact from "preact";
import { css } from "typesafecss";
import { observer } from "../render-utils/observer";
import { formatTime } from "socket-function/src/formatting/format";

let watchState = observable({
    pending: {} as { [group: string]: string }
});
let pendingLastSets = new Map<string, number>();

let pendingCache = new Map<string, string>();

// "" clears the pending value
export function setPending(group: string, message: string) {
    pendingCache.set(group, message);
    void setPendingBase();
}

export function hasPending(): boolean {
    return Object.keys(watchState.pending).length > 0;
}

// NOTE: This not only prevents render overload, but also means any pending that are < this
//  delay don't show up (which is useful to reduce unnecessary pending messages).
const setPendingBase = throttleFunction(500, function setPendingBase() {
    for (let [group, message] of pendingCache) {

        if (!message) {
            let lastSet = pendingLastSets.get(group);
            if (lastSet) {
                let duration = Date.now() - lastSet;
                if (duration > 500) {
                    console.log(`Finished slow task after ${formatTime(duration)}: ${JSON.stringify(group)}, last is ${JSON.stringify(watchState.pending[group])}`);
                }
                pendingLastSets.delete(group);
            }
            delete watchState.pending[group];
        } else {
            //console.log("setPending", group, message);
            if (!(group in watchState.pending)) {
                pendingLastSets.set(group, Date.now());
            }
            watchState.pending[group] = message;
        }
    }
    pendingCache.clear();
});

@observer
export class PendingDisplay extends preact.Component {
    render() {
        // Single line, giving equal space, and ellipsis for overflow
        return <div className={css.hbox(10)}>
            {Object.keys(watchState.pending).map(group => (
                <div className={css.center.textOverflow("ellipsis").border("1px solid black").pad2(6, 2)}>
                    {group}: {watchState.pending[group]}
                </div>
            ))}
        </div>;
    }
}