import preact from "preact";
export declare function showModal(config: {
    contents: preact.ComponentChildren;
    onClose?: () => void;
}): {
    close: () => void;
};
export declare function closeAllModals(): void;
