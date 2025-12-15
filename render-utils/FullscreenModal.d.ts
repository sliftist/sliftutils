import preact from "preact";
export declare function showFullscreenModal(config: {
    contents: preact.ComponentChildren;
    onClose?: () => void;
}): void;
export declare class FullscreenModal extends preact.Component<{
    parentState?: {
        open: boolean;
    };
    onCancel?: () => void;
    style?: preact.JSX.CSSProperties;
    outerStyle?: preact.JSX.CSSProperties;
}> {
    render(): preact.JSX.Element;
}
