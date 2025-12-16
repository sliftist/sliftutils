import preact from "preact";
type InputProps = (preact.JSX.HTMLAttributes<HTMLInputElement> & {
    /** ONLY throttles onChangeValue */
    throttle?: number;
    flavor?: "large" | "small" | "none";
    focusOnMount?: boolean;
    textarea?: boolean;
    /** Update on key stroke, not on blur (just does onInput = onChange, as onInput already does this) */
    hot?: boolean;
    /** Updates arrow keys with modifier behavior to use larger numbers, instead of decimals. */
    integer?: boolean;
    /** Only works with number/integer */
    reverseArrowKeyDirection?: boolean;
    inputRef?: (x: HTMLInputElement | null) => void;
    /** Don't blur on enter key */
    noEnterKeyBlur?: boolean;
    noFocusSelect?: boolean;
    inputKey?: string;
    fillWidth?: boolean;
    autocompleteValues?: string[];
    /** Forces the input to update when focused. Usually we hold updates, to prevent the user's
     *      typing to be interrupted by background updates.
     *      NOTE: "hot" is usually required when using this.
     */
    forceInputValueUpdatesWhenFocused?: boolean;
    onChangeValue?: (value: string) => void;
});
export type InputLabelProps = Omit<InputProps, "label" | "title"> & {
    label?: preact.ComponentChild;
    number?: boolean;
    /** A number, AND, an integer. Changes behavior arrow arrow keys as well */
    integer?: boolean;
    checkbox?: boolean;
    edit?: boolean;
    alwaysShowPencil?: boolean;
    outerClass?: string;
    maxDecimals?: number;
    percent?: boolean;
    editClass?: string;
    fontSize?: number;
    tooltip?: string;
    fillWidth?: boolean;
    useDateUI?: boolean;
};
export declare const startGuessDateRange: number;
export declare const endGuessDateRange: number;
export declare class InputLabel extends preact.Component<InputLabelProps> {
    synced: {
        editting: boolean;
        editInputValue: string;
        editUpdateSeqNum: number;
    };
    render(): preact.JSX.Element;
}
export declare class InputLabelURL extends preact.Component<InputLabelProps & {
    persisted: {
        value: unknown;
    };
}> {
    render(): preact.JSX.Element;
}
export {};
