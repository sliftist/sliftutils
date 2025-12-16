import preact from "preact";
import { css } from "typesafecss";
import { observer } from "./observer";
import { throttleFunction } from "socket-function/src/misc";

// TODO: Autogrow mode while typing

// NOTE: "value" is optional. If you don't pass "value", we will preserve the value.
//  This is useful for inputs which you want to run an action on, such as "add new item",
//      as it allows you to remove a local state value to cache the value, by just
//      doing the add on "onChangeValue".
// IMPORTANT! InputProps is in both InputLabel.tsx and Input.tsx, so the types export correctly
export type InputProps = (
    preact.JSX.HTMLAttributes<HTMLInputElement>
    & {
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

        // NOTE: We trigger onChange (and onChangeValue) whenever
        //      e.ctrlKey && (e.code.startsWith("Key") || e.code === "Enter") || e.code === "Enter" && e.shiftKey
        //  This is because ctrl usually means a hotkey, and hotkeys usually want committed values.
        onChangeValue?: (value: string) => void;
    }
);


@observer
export class Input extends preact.Component<InputProps> {
    onFocusText = "";
    firstFocus = true;

    elem: HTMLInputElement | null = null;
    lastValue: unknown = null;
    lastChecked: unknown = null;

    onChangeThrottle: undefined | {
        throttle: number;
        run: (newValue: string) => void;
    } = undefined;

    render() {
        let flavorOverrides: preact.JSX.CSSProperties = {};
        const { flavor, textarea, hot, inputKey, fillWidth, ...nativeProps } = this.props;
        let props = { ...nativeProps } as preact.RenderableProps<InputProps>;

        if (props.onChangeValue) {
            let throttle = this.props.throttle;
            if (throttle) {
                let existingThrottle = this.onChangeThrottle;
                if (existingThrottle?.throttle !== throttle) {
                    existingThrottle = this.onChangeThrottle = {
                        throttle,
                        run: throttleFunction(throttle, (newValue) => {
                            this.props.onChangeValue?.(newValue);
                        })
                    };
                }
                props.onChangeValue = existingThrottle.run;
            }
        }
        if (flavor === "large") {
            flavorOverrides = {
                fontSize: 18,
                padding: "10px 15px",
            };
            if (props.type === "checkbox") {
                flavorOverrides.width = 16;
                flavorOverrides.height = 16;
            }
        }
        if (flavor === "small") {
            flavorOverrides = {
                fontSize: 12,
                padding: "5px 10px",
            };
        }

        // IMPORTANT! When focused, preserve the input value, otherwise typing is annoying.
        //  This doesn't usually happen, but can if background tasks are updating the UI
        //  while the user is typing.


        let attributes: preact.JSX.HTMLAttributes<HTMLInputElement> = {
            ...nativeProps,
            key: inputKey || "input",
            ref: x => {
                if (x) {
                    this.elem = x;
                }
                if (x && props.focusOnMount && this.firstFocus) {
                    this.firstFocus = false;
                    setTimeout(() => {
                        x.focus();
                    }, 0);
                }
                let ref = props.inputRef;
                if (typeof ref === "function") {
                    ref(x);
                }
            },
            class: undefined,
            className: (
                (props.className || props.class || " ")
                + css.display("flex", "soft")
                    .outline("3px solid hsl(204, 100%, 50%)", "focus", "soft")
                + (fillWidth && css.fillWidth)
            ),
            style: {
                ...flavorOverrides,
                ...props.style as any,
            },
            onFocus: e => {
                if (props.type === "checkbox") return;
                this.onFocusText = e.currentTarget.value;
                if (!props.noFocusSelect) {
                    e.currentTarget.select();
                }
                props.onFocus?.(e);
            },
            onBlur: e => {
                if (props.type === "checkbox") return;
                props.onBlur?.(e);
                if (e.currentTarget.value === this.lastValue && e.currentTarget.checked === this.lastChecked && hot) return;
                this.lastValue = e.currentTarget.value;
                this.lastChecked = e.currentTarget.checked;
                let result = props.onInput?.(e as any);
                result = props.onChange?.(e) || result;
                result = props.onChangeValue?.(e.currentTarget.value) || result;
                return result;
            },
            onChange: e => {
                if (props.type !== "checkbox" && e.currentTarget.value === this.lastValue && e.currentTarget.checked === this.lastChecked) return;
                this.lastValue = e.currentTarget.value;
                this.lastChecked = e.currentTarget.checked;
                let result: unknown = undefined;
                if (!props.onChangeValue || hot) {
                    result = props.onChange?.(e) || result;
                }
                if (hot) {
                    result = props.onChangeValue?.(e.currentTarget.value) || result;
                }
                return result;
            },
            onKeyDown: e => {
                if (e.defaultPrevented) return;
                // if (textarea && e.code === "Tab") {
                //     e.preventDefault();
                //     // Inject 4 spaces into the current position
                //     let elem = e.currentTarget;
                //     let value = elem.value;
                //     let start = elem.selectionStart ?? elem.value.length;
                //     let end = elem.selectionEnd ?? elem.value.length;
                //     elem.value = value.slice(0, start) + "    " + value.slice(end);
                //     elem.selectionStart = elem.selectionEnd = start + 4;
                //     return;
                // }
                props.onKeyDown?.(e);
                if (e.code === "Enter" && e.ctrlKey) {
                    e.currentTarget.blur();
                }
                let callback = props.onInput;
                if (!callback && hot) {
                    callback = props.onChange;
                }

                // Convert tab to 4 spaces
                if (e.code === "Tab" && textarea) {
                    e.preventDefault();
                    let elem = e.currentTarget;
                    let value = elem.value;
                    let start = elem.selectionStart ?? elem.value.length;
                    let end = elem.selectionEnd ?? elem.value.length;
                    elem.value = value.slice(0, start) + "    " + value.slice(end);
                    elem.selectionStart = elem.selectionEnd = start + 4;
                    callback?.(e as unknown as preact.JSX.TargetedInputEvent<HTMLInputElement>);
                    return;
                }
                if (this.elem && props.type === "number") {
                    let delta = 0;
                    let magnitude = 1;
                    if (e.shiftKey) {
                        if (props.integer) {
                            magnitude = 10;
                        } else {
                            magnitude = 0.1;
                        }
                    }
                    if (e.code === "ArrowUp") {
                        delta = magnitude;
                    } else if (e.code === "ArrowDown") {
                        delta = -magnitude;
                    }
                    if (props.reverseArrowKeyDirection) {
                        delta *= -1;
                    }
                    if (delta !== 0) {
                        e.preventDefault();
                        let newValue = Math.round(((+this.elem.value || 0) + delta) * 100) / 100;
                        e.currentTarget.value = newValue.toString();
                        callback?.(e as unknown as preact.JSX.TargetedInputEvent<HTMLInputElement>);
                    }
                }
                let { noEnterKeyBlur, onInput, onChange } = props;
                // Detach from the synced function, to prevent double calls. This is important, as apparently .blur()
                //  synchronously triggers onChange, BUT, only if the input is changing the first time. Which means
                //  if this function reruns, it won't trigger the change again. Detaching it causes any triggered
                //  functions to become root synced functions, which will allow them to correctly run the sync loop.
                void Promise.resolve().finally(() => {
                    if (e.defaultPrevented) return;
                    if (e.code === "Escape") {
                        let changed = e.currentTarget.value !== this.onFocusText;
                        e.currentTarget.value = this.onFocusText;
                        if (onInput) {
                            onInput?.(e as unknown as preact.JSX.TargetedInputEvent<HTMLInputElement>);
                        } else if (changed) {
                            if (onChange) {
                                onChange?.(e);
                            }
                        }
                        e.currentTarget.blur();
                    }
                    if (!noEnterKeyBlur && e.code === "Enter" && (!textarea || e.shiftKey || e.ctrlKey) || props.autocompleteValues && e.code === "Tab") {
                        e.currentTarget.blur();
                    } else if (e.ctrlKey && (e.code.startsWith("Key") || e.code === "Enter") || e.shiftKey && e.code === "Enter") {
                        onChange?.(e);
                    }
                });
            },
            onInput: e => {
                if (props.autocompleteValues) {
                    if (e.inputType === "insertText") {
                        let curValue = e.currentTarget.value.toLowerCase();
                        let match = props.autocompleteValues.find(x => x.toLowerCase().startsWith(curValue));
                        if (match) {
                            e.currentTarget.value = match || "";
                            // Select the part after the previous match, so when they type, they clobber the match part
                            let start = curValue.length;
                            let end = e.currentTarget.value.length;
                            e.currentTarget.selectionStart = start;
                            e.currentTarget.selectionEnd = end;
                        }
                    }
                }
                props.onInput?.(e);
            },
        };


        if ("value" in props && props.type !== "checkbox") {
            let elem = this.elem;
            let newValue = props.value;
            if (!this.props.forceInputValueUpdatesWhenFocused && elem && elem === document.activeElement) {
                newValue = elem.value;
            }
            attributes.value = newValue;
            this.lastValue = String(props.value);
        }
        if ("checked" in props) {
            this.lastChecked = !!props.checked;
        }


        if (attributes.type === "number") {
            // Fix stuff like 55.00000000000001
            let value = attributes.value;
            if (typeof value === "number") {
                value = niceNumberStringify(value);
            }
        }

        // We do number handling ourselves
        if (attributes["type"] === "number") {
            delete attributes["type"];
        }

        if (props.type === "checkbox") {

        } else if (hot) {
            attributes.onInput = attributes.onChange;
        } else {
            // We use onChange from onBlur, so don't use the onChange handler, as preact will hook this up
            //  with onInput, which will cause it to trigger as if the component is hot!
            delete attributes.onChange;
        }
        if (textarea) {
            return <textarea {...attributes as any} />;
        } else {
            return <input {...attributes} />;
        }
    }
}


function niceNumberStringify(valueIn: number) {
    if (Math.abs(valueIn) < 0.0000000001) {
        return "0";
    }
    let value = valueIn.toString();
    // TODO: Do this MUCH better...
    if (value.slice(0, -1).endsWith("00000000000")) {
        value = value.slice(0, -1);
        while (value.endsWith("0")) {
            value = value.slice(0, -1);
        }
        if (value.endsWith(".")) {
            value = value.slice(0, -1);
        }
        return value;
    }
    if (value.slice(0, -1).endsWith("9999999999")) {
        value = value.slice(0, -1);
        while (value.endsWith("9")) {
            value = value.slice(0, -1);
        }
        if (value.endsWith(".")) {
            value = value.slice(0, -1);
        }
        // NOTE: Interestingly enough... because we remove all trailing 9s, it means if the last number is not 9,
        //  so... we can do this hack to round up
        value = value.slice(0, -1) + (parseInt(value.slice(-1)) + 1);
        return value;
    }
    return value;
}
