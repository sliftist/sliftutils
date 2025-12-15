import preact from "preact";
import { Input, InputProps } from "./Input";
import { css } from "typesafecss";
import { lazy } from "socket-function/src/caching";
import { observer } from "./observer";
import { observable } from "mobx";


export type InputLabelProps = Omit<InputProps, "label" | "title"> & {
    label?: preact.ComponentChild;
    number?: boolean;
    /** A number, AND, an integer. Changes behavior arrow arrow keys as well */
    integer?: boolean;
    checkbox?: boolean;
    // Show text and a pencil, only showing the input on click
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

function roundToDecimals(value: number, decimals: number) {
    return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

export const startGuessDateRange = +new Date(2010, 0, 1).getTime();
export const endGuessDateRange = +new Date(2050, 0, 1).getTime();

@observer
export class InputLabel extends preact.Component<InputLabelProps> {
    synced = observable({
        editting: false,
        editInputValue: "",
        editUpdateSeqNum: 0,
    });

    render() {
        let props = { ...this.props };

        function addValueMapping(mapper: (value: string) => string) {
            const baseOnChange = props.onChange;
            if (baseOnChange) {
                props.onChange = e => {
                    baseOnChange({ currentTarget: { value: mapper(e.currentTarget.value) } } as any);
                };
            }
            const baseOnChangeValue = props.onChangeValue;
            if (baseOnChangeValue) {
                props.onChangeValue = e => {
                    baseOnChangeValue(mapper(e));
                };
            }
            const baseOnBlur = props.onBlur;
            if (baseOnBlur) {
                props.onBlur = e => {
                    baseOnBlur({ currentTarget: { value: mapper(e.currentTarget.value) } } as any);
                };
            }
            const baseOnInput = props.onInput;
            if (baseOnInput) {
                props.onInput = e => {
                    baseOnInput({ currentTarget: { value: mapper(e.currentTarget.value) } } as any);
                };
            }
        }

        let label = props.label || props.children;
        (props as any).title = props.tooltip;
        if ("value" in props) {
            props.value = props.value ?? "";
        }

        if ((!props.type || props.type === "number") && props.useDateUI) {
            let value = String(props.value);
            props.type = "datetime-local";
            props.edit = false;
            props.textarea = false;
            props.number = false;
            props.forceInputValueUpdatesWhenFocused = true;
            // NOTE: When using forceInputValueUpdatesWhenFocused we need hot, otherwise the user's updates
            //  won't be visible.
            props.hot = true;
            if (isJSNumber(value)) {
                value = formatDateTimeForInput(+value);
            } else {
                value = "";
            }
            props.value = value;
            addValueMapping(value => (new Date(value).getTime() || Date.now()) as any);
        }
        if (props.fontSize !== undefined) {
            props.style = { ...props.style as any, fontSize: props.fontSize };
        }
        if (props.integer) {
            props.number = true;
        }
        if (props.number) {
            props.type = "number";
        }
        if (props.checkbox) {
            props.type = "checkbox";
        }
        if (props.percent) {
            props.value = (Number(props.value) || 0) * 100;
            addValueMapping(value => String(+value / 100));
            props.maxDecimals = props.maxDecimals ?? 2;
            props.number = props.number ?? true;
            props.type = "number";
        }
        let maxDecimals = props.maxDecimals;
        if (typeof maxDecimals === "number") {
            props.value = roundToDecimals(Number(props.value), maxDecimals);
        }

        function formatDateTimeForInput(value: number) {
            value -= new Date(value).getTimezoneOffset() * 60 * 1000;
            return new Date(value).toISOString().slice(0, -1);
        }

        let style = { ...props.style as any };
        if (props.type === "number") {
            let fontSize = props.fontSize ?? 12;
            style.width = 40 + String(props.value).length * (fontSize * 0.75);
        }
        let onClick: ((e: preact.JSX.TargetedMouseEvent<HTMLElement>) => void) | undefined;
        if (props.edit) {
            let baseBlur = props.onBlur;
            props.onBlur = e => {
                this.synced.editting = false;
                baseBlur?.(e);
            };
            onClick = (e) => {
                e.stopPropagation();
                this.synced.editting = true;
            };
        }

        let stateEditting = this.synced.editting;
        let sizeBasedOnContents = props.edit;
        if (props.edit && !stateEditting) {
            sizeBasedOnContents = false;
        }
        if (sizeBasedOnContents) {
            let baseChange = props.onChange;
            props.onChange = e => {
                this.synced.editUpdateSeqNum++;
                baseChange?.(e);
            };
            this.synced.editUpdateSeqNum;
        }

        let input = <Input
            {...props}
            label={String(label)}
            style={style}
            className={
                (
                    props.flavor === "large" && "large "
                    || props.flavor === "none" && " "
                    || "tiny "
                )
                + (props.class || props.className)
                + (sizeBasedOnContents && css.absolute.pos(0, 0).fillBoth.resize("none") || "")
            }
            onInput={e => {
                if (props.edit) {
                    this.synced.editInputValue = e.currentTarget.value;
                }
                props.onInput?.(e);
            }}
        />;

        if (props.edit && !stateEditting) {
            input = <span className={
                css.hbox(2) + " inputPlaceholder trigger-hover "
                + props.editClass
            }>
                <span
                    className={
                        css.whiteSpace("pre-wrap")
                        + (props.class || props.className)
                    }
                >
                    {props.value}
                </span>
                <span className={css.opacity(0.1).opacity(1, "hover")}>
                    {pencilSVG()}
                </span>
            </span>;
        }
        return (
            <label onClick={onClick} className={
                css.hbox(5).relative
                + " trigger-hover "
                + props.outerClass
                + (props.flavor === "large" && css.fontSize(18, "soft"))
                + (props.fillWidth && css.fillWidth)
                + css.position("relative", "soft")
            }>
                {/* Extra UI so the textarea sizes properly. */}
                {sizeBasedOnContents &&
                    <span
                        className={
                            css.whiteSpace("pre-wrap")
                            //.opacity(0)
                            //.pointerEvents("none")
                            + (props.editClass)
                            + " " + (props.class || props.className)
                        }
                    >
                        {/* We add another character, so "a\n" results in two lines, instead of 1. */}
                        {this.synced.editInputValue || props.value || props.placeholder} |
                    </span>
                }
                {/* <div
                    className={
                        "show-on-hover "
                        + css.hsla(0, 0, 0, 0.2)
                            .absolute.pos(-8, -2).size("calc(100% + 16px)" as "100%", "calc(100% + 4px)" as "100%")
                            .zIndex(-1)
                            .pointerEvents("none")
                    }
                /> */}
                {label && <span className={css.fontWeight("bold").flexShrink0}>{label}</span>}
                {input}
            </label>
        );
    }
}

const pencilSVG = lazy(() => {
    const src = "data:image/svg+xml;base64," + Buffer.from(`
    <svg width="24" height="24" viewBox="-1 1 23 25" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5.98012 19.3734L8.60809 18.7164C8.62428 18.7124 8.64043 18.7084 8.65654 18.7044C8.87531 18.65 9.08562 18.5978 9.27707 18.4894C9.46852 18.381 9.62153 18.2275 9.7807 18.0679C9.79242 18.0561 9.80418 18.0444 9.81598 18.0325L17.0101 10.8385L17.0101 10.8385L17.0369 10.8117C17.3472 10.5014 17.6215 10.2272 17.8128 9.97638C18.0202 9.70457 18.1858 9.39104 18.1858 9C18.1858 8.60896 18.0202 8.29543 17.8128 8.02361C17.6215 7.77285 17.3472 7.49863 17.0369 7.18835L17.01 7.16152L16.8385 6.98995L16.8117 6.96314C16.5014 6.6528 16.2272 6.37853 15.9764 6.1872C15.7046 5.97981 15.391 5.81421 15 5.81421C14.609 5.81421 14.2954 5.97981 14.0236 6.1872C13.7729 6.37853 13.4986 6.65278 13.1884 6.96311L13.1615 6.98995L5.96745 14.184C5.95565 14.1958 5.94386 14.2076 5.93211 14.2193C5.77249 14.3785 5.61904 14.5315 5.51064 14.7229C5.40225 14.9144 5.34999 15.1247 5.29562 15.3435C5.29162 15.3596 5.28761 15.3757 5.28356 15.3919L4.62003 18.046C4.61762 18.0557 4.61518 18.0654 4.61272 18.0752C4.57411 18.2293 4.53044 18.4035 4.51593 18.5518C4.49978 18.7169 4.50127 19.0162 4.74255 19.2574C4.98383 19.4987 5.28307 19.5002 5.44819 19.4841C5.59646 19.4696 5.77072 19.4259 5.92479 19.3873C5.9346 19.3848 5.94433 19.3824 5.95396 19.38L5.95397 19.38L5.9801 19.3734L5.98012 19.3734Z" stroke="#33363F" stroke-width="1.2" fill="hsl(330, 50%, 60%)" />
        <path d="M12.5 7.5L5.92819 14.0718C5.71566 14.2843 5.60939 14.3906 5.53953 14.5212C5.46966 14.6517 5.44019 14.7991 5.38124 15.0938L4.64709 18.7646C4.58057 19.0972 4.5473 19.2635 4.64191 19.3581C4.73652 19.4527 4.90283 19.4194 5.23544 19.3529L8.90621 18.6188C9.20093 18.5598 9.3483 18.5303 9.47885 18.4605C9.60939 18.3906 9.71566 18.2843 9.92819 18.0718L16.5 11.5L12.5 7.5Z" fill="hsl(45, 100%, 50%)" />
        <path d="M12.5 7.5L16.5 11.5" stroke="#33363F" stroke-width="1.2" />
    </svg>
    `).toString("base64");
    return <img draggable={false} src={src} />;
});

@observer
export class InputLabelURL extends preact.Component<InputLabelProps & {
    persisted: { value: unknown };
}> {
    render() {
        this.props.persisted.value;
        let props = { ...this.props };
        if (props.type === "number" || props.number) {
            return <InputLabel {...props} value={Number(props.persisted.value) || 0} onChange={e => { props.persisted.value = e.currentTarget.value; props.onChange?.(e); }} />;
        } else if (props.type === "checkbox" || this.props.checkbox) {
            return <InputLabel
                {...props}
                checked={Boolean(props.persisted.value) || false}
                onFocus={e => e.currentTarget.blur()}
                onChange={e => {
                    props.persisted.value = e.currentTarget.checked ? "1" : "";
                    props.onChange?.(e);
                }}
            />;
        } else {
            return <InputLabel {...props} value={String(props.persisted.value) || ""} onChange={e => { props.persisted.value = e.currentTarget.value; props.onChange?.(e); }} />;
        }
    }
}

function isJSNumber(value: string) {
    return !isNaN(+value);
}
