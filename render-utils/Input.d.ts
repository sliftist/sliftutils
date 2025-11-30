import preact from "preact";
export type InputProps = (preact.JSX.HTMLAttributes<HTMLInputElement> & {
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
export declare class Input extends preact.Component<InputProps> {
    onFocusText: string;
    firstFocus: boolean;
    elem: HTMLInputElement | null;
    lastValue: unknown;
    lastChecked: unknown;
    onChangeThrottle: undefined | {
        throttle: number;
        run: (newValue: string) => void;
    };
    render(): preact.JSX.Element;
}
