import preact from "preact";
export type InputOption<T> = {
    value: T;
    label?: preact.ComponentChild;
    matchText?: string;
};
export type FullInputOption<T> = {
    value: T;
    label: preact.ComponentChild;
    matchText: string;
};
export declare class InputPickerURL extends preact.Component<{
    label?: preact.ComponentChild;
    options: (string | InputOption<string>)[];
    allowNonOptions?: boolean;
    value: {
        value: string;
    };
}> {
    render(): preact.JSX.Element;
}
export declare class InputPicker<T> extends preact.Component<{
    label?: preact.ComponentChild;
    picked: T[];
    options: InputOption<T>[];
    addPicked: (value: T) => void;
    removePicked: (value: T) => void;
    allowNonOptions?: boolean;
}> {
    synced: {
        pendingText: string;
        focused: boolean;
    };
    render(): preact.JSX.Element;
}
