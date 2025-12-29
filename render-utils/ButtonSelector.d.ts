import preact from "preact";
export declare class ButtonSelector<T> extends preact.Component<{
    title?: string;
    value: T;
    options: {
        value: T;
        title: preact.ComponentChild;
        isDefault?: boolean;
        hotkeys?: string[];
    }[];
    onChange: (value: T) => void;
    noPadding?: boolean;
    noDefault?: boolean;
    noUI?: boolean;
    classWrapper?: string;
}> {
    render(): preact.JSX.Element;
}
