import { MaybePromise } from "socket-function/src/types";
import { runInAction } from "./mobxTyped";

export let dragCount = 0;

type DragOffset = { x: number; y: number };

function throttleFunctionFast<Args extends unknown[]>(
    fnc: (...args: Args) => MaybePromise<void>
): (...args: Args) => void {
    let pendingCall: { args: Args } | undefined;
    let inCall = false;
    return async (...args: Args) => {
        if (inCall) {
            pendingCall = { args };
            return;
        }
        inCall = true;
        try {
            await fnc(...args);
        } finally {
            inCall = false;
            if (pendingCall) {
                let call = pendingCall;
                pendingCall = undefined;
                void fnc(...call.args);
            }
        }
    };
}

function inAction<Args extends unknown[]>(fnc: (...args: Args) => void): (...args: Args) => void {
    return (...args: Args) => runInAction(() => fnc(...args));
}

export function performDrag(
    e: MouseEvent,
    onMove: (offset: DragOffset) => void,
    onDone?: (offset: DragOffset) => void,
) {
    return performDrag2({ e, onMove, onDone });
}

export function performDrag2(
    config: {
        e: MouseEvent;
        onMove?: (offset: DragOffset) => void;
        onDone?: (offset: DragOffset) => void;
        onFinally?: (passedSlop: boolean) => void;
        slop?: number;
    }
) {
    let { e, slop } = config;
    let onMove = inAction(config.onMove ?? (() => { }));
    let onDone = config.onDone && inAction(config.onDone);
    let onFinally = config.onFinally && inAction(config.onFinally);
    dragCount++;

    let startMouseX = e.clientX;
    let startMouseY = e.clientY;
    let lastMouseX = e.clientX;
    let lastMouseY = e.clientY;

    let passedSlop = !slop;

    function cancel() {
        lastMouseX = startMouseX;
        lastMouseY = startMouseY;
        finish();
    }

    let finished = false;
    let disposed = false;

    const triggerMove = throttleFunctionFast(async () => {
        if (disposed) return;
        let deltaX = lastMouseX - startMouseX;
        let deltaY = lastMouseY - startMouseY;
        if (slop) {
            let dist = Math.sqrt(deltaX ** 2 + deltaY ** 2);
            if (dist > slop) passedSlop = true;
            if (!passedSlop) return;
        }
        onMove({ x: deltaX, y: deltaY });
        await new Promise(r => requestAnimationFrame(r));
    });

    const onMouseMove = (e: MouseEvent) => {
        if (finished) return;
        if (e.buttons === 0) {
            finish();
            return;
        }
        if (lastMouseX === e.clientX && lastMouseY === e.clientY) return;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        triggerMove();
    };
    let finish = () => {
        selfCancelCallback.delete(cancel);
        try {
            if (finished) return;
            finished = true;
            dragCount--;
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", finish, { capture: true });
            window.removeEventListener("blur", onBlur);
            document.removeEventListener("keydown", keyDown);
            triggerMove();
            if (onDone) {
                let deltaX = lastMouseX - startMouseX;
                let deltaY = lastMouseY - startMouseY;
                if (slop) {
                    let dist = Math.sqrt(deltaX ** 2 + deltaY ** 2);
                    if (dist > slop) passedSlop = true;
                    if (!passedSlop) return;
                }
                onDone({ x: deltaX, y: deltaY });
            }
        } finally {
            setTimeout(() => {
                onFinally?.(passedSlop);
            }, 0);
        }
        disposed = true;
    };

    const keyDown = (e: KeyboardEvent) => {
        if (finished) return;
        if (e.code === "Escape") {
            cancel();
        }
    };

    const onBlur = () => {
        if (finished) return;
        cancel();
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", finish, { capture: true });
    window.addEventListener("blur", onBlur);
    document.addEventListener("keydown", keyDown);
    selfCancelCallback.add(cancel);

    if (!slop) {
        onMove({ x: 0, y: 0 });
    }
}

let selfCancelCallback = new Set<() => void>();
export function cancelDrag() {
    for (let callback of selfCancelCallback) {
        try {
            callback();
        } catch (e) {
            console.error(`Error in drag cancel callback: ${(e as Error).stack ?? e}`);
        }
    }
    selfCancelCallback.clear();
}
