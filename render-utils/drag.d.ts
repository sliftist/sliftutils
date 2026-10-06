export declare let dragCount: number;
type DragOffset = {
    x: number;
    y: number;
};
export declare function performDrag(e: MouseEvent, onMove: (offset: DragOffset) => void, onDone?: (offset: DragOffset) => void): void;
export declare function performDrag2(config: {
    e: MouseEvent;
    onMove?: (offset: DragOffset) => void;
    onDone?: (offset: DragOffset) => void;
    onFinally?: (passedSlop: boolean) => void;
    slop?: number;
}): void;
export declare function cancelDrag(): void;
export {};
