import { MaybePromise } from "socket-function/src/types";
import { runInAction } from "./mobxTyped";

export let dragCount = 0;

const ARROW_STEP_PER_FRAME = 1;
const ARROW_STEP_PER_FRAME_SHIFT = 10;
const ARROW_STEP_PER_FRAME_CTRL = 0.1;
const ARROW_DIRECTIONS: { [code: string]: DragOffset } = {
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
};

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
    let keyX = 0;
    let keyY = 0;
    let heldArrows = new Set<string>();
    let shiftHeld = e.shiftKey;
    let ctrlHeld = e.ctrlKey;
    let arrowRepeatRunning = false;

    let passedSlop = !slop;

    function getDelta(): DragOffset {
        let deltaX = lastMouseX - startMouseX + keyX;
        let deltaY = lastMouseY - startMouseY + keyY;
        if (slop) {
            let dist = Math.sqrt(deltaX ** 2 + deltaY ** 2);
            if (dist > slop) passedSlop = true;
        }
        return { x: deltaX, y: deltaY };
    }

    function cancel() {
        lastMouseX = startMouseX;
        lastMouseY = startMouseY;
        keyX = 0;
        keyY = 0;
        finish();
    }

    let finished = false;
    let disposed = false;

    const triggerMove = throttleFunctionFast(async () => {
        if (disposed) return;
        let delta = getDelta();
        if (!passedSlop) return;
        onMove(delta);
        await new Promise(r => requestAnimationFrame(r));
    });

    function applyArrowStep() {
        let step = ARROW_STEP_PER_FRAME;
        if (shiftHeld) {
            step = ARROW_STEP_PER_FRAME_SHIFT;
        } else if (ctrlHeld) {
            step = ARROW_STEP_PER_FRAME_CTRL;
        }
        for (let code of heldArrows) {
            let direction = ARROW_DIRECTIONS[code];
            keyX += direction.x * step;
            keyY += direction.y * step;
        }
        triggerMove();
    }

    function runArrowRepeat() {
        if (arrowRepeatRunning) return;
        arrowRepeatRunning = true;
        const frame = () => {
            if (finished || !heldArrows.size) {
                arrowRepeatRunning = false;
                return;
            }
            applyArrowStep();
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }

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
            document.removeEventListener("keyup", keyUp);
            triggerMove();
            if (onDone) {
                let delta = getDelta();
                if (!passedSlop) return;
                onDone(delta);
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
        shiftHeld = e.shiftKey;
        ctrlHeld = e.ctrlKey;
        if (e.code === "Escape") {
            cancel();
            return;
        }
        if (!ARROW_DIRECTIONS[e.code]) return;
        e.preventDefault();
        if (e.repeat || heldArrows.has(e.code)) return;
        heldArrows.add(e.code);
        applyArrowStep();
        runArrowRepeat();
    };

    const keyUp = (e: KeyboardEvent) => {
        if (finished) return;
        shiftHeld = e.shiftKey;
        ctrlHeld = e.ctrlKey;
        heldArrows.delete(e.code);
    };

    const onBlur = () => {
        if (finished) return;
        cancel();
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", finish, { capture: true });
    window.addEventListener("blur", onBlur);
    document.addEventListener("keydown", keyDown);
    document.addEventListener("keyup", keyUp);
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
