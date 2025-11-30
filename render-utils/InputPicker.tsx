import preact from "preact";
import { observable } from "mobx";
import { observer } from "./observer";
import { sort } from "socket-function/src/misc";
import { css } from "typesafecss";
import { Input } from "./Input";
import { greenButton, yellowButton } from "./colors";

export type InputOption<T> = {
    value: T;
    // Defaults to String(value)
    label?: preact.ComponentChild;
    // Defaults to typeof label === "string" ? label : String(value)
    matchText?: string;
};
export type FullInputOption<T> = {
    value: T;
    label: preact.ComponentChild;
    matchText: string;
};

@observer
export class InputPickerURL extends preact.Component<{
    label?: preact.ComponentChild;
    options: (string | InputOption<string>)[];
    allowNonOptions?: boolean;
    value: { value: string };
}> {
    render() {
        let { value, options, ...remaining } = this.props;
        let values = new Set(value.value.split("|").filter(x => x));
        return <InputPicker
            {...remaining}
            picked={Array.from(values)}
            addPicked={v => {
                values.add(v);
                value.value = Array.from(values).join("|");
            }}
            removePicked={v => {
                values.delete(v);
                value.value = Array.from(values).join("|");
            }}
            options={options.map(x => typeof x === "string" ? { value: x } : x)}
        />;
    }
}

@observer
export class InputPicker<T> extends preact.Component<{
    label?: preact.ComponentChild;
    picked: T[];
    options: InputOption<T>[];
    addPicked: (value: T) => void;
    removePicked: (value: T) => void;
    allowNonOptions?: boolean;
}> {
    synced = observable({
        pendingText: "",
        focused: false,
    });
    render() {
        // Input, and beside it the picked values
        let resolvedOptions = this.props.options.map(option => {
            let value = option.value;
            let label = option.label ?? String(value);
            let matchText = option.matchText ?? (typeof label === "string" ? label : String(value));
            return { value, label, matchText };
        });
        let optionLookup = new Map(resolvedOptions.map((option) => [option.value, option]));
        let pickedOptions = this.props.picked.map(x => optionLookup.get(x) || { value: x, label: String(x), matchText: String(x) });
        let pendingMatches: FullInputOption<T>[] = [];
        let pendingTextFull = this.synced.pendingText;
        let pendingText = pendingTextFull.trim().toLowerCase();
        if (pendingText) {
            pendingMatches = resolvedOptions.filter(option => option.matchText.toLowerCase().includes(pendingText));
            sort(pendingMatches, x =>
                x.matchText.startsWith(pendingTextFull) && -10
                || x.matchText.startsWith(pendingText) && -9
                || x.matchText.toLowerCase().startsWith(pendingTextFull) && -8
                || x.matchText.toLowerCase().startsWith(pendingText) && -7
                || x.matchText.length
            );
        } else if (this.synced.focused) {
            pendingMatches = resolvedOptions;
        }
        let extra = pendingMatches.length;
        pendingMatches = pendingMatches.slice(0, 10);
        extra -= pendingMatches.length;
        return (
            <div className={css.hbox(10).alignItems("start")}>
                {this.props.label}
                <Input
                    value={this.synced.pendingText}
                    hot
                    forceInputValueUpdatesWhenFocused
                    onChangeValue={(x) => this.synced.pendingText = x}
                    onFocus={() => this.synced.focused = true}
                    onBlur={() => {
                        this.synced.focused = false;
                        this.synced.pendingText = "";
                    }}
                    onKeyDown={e => {
                        // On tab, add first in pendingMatches
                        if (e.key === "Tab") {
                            e.preventDefault();
                            if (pendingMatches.length > 0) {
                                this.props.addPicked(pendingMatches[0].value);
                                this.synced.pendingText = "";
                            } else if (this.props.allowNonOptions) {
                                this.props.addPicked(this.synced.pendingText as T);
                                this.synced.pendingText = "";
                            }
                        } else if (e.key === "Enter" && this.props.allowNonOptions) {
                            // HACK: I don't even know, this is just terrible. But it is used to fix some UI where we needed a way to inject text
                            this.props.addPicked(this.synced.pendingText as T);
                            this.synced.pendingText = "";
                        }
                    }}
                />
                {pendingMatches.length > 0 && (
                    <div className={css.hbox(4).wrap}>
                        {pendingMatches.map((option) => (
                            <button
                                key={`add-${option.matchText}`}
                                className={css.hbox(5).button + greenButton}
                                // On mouse down, so we can add picked BEFORE we blur (otherwise
                                //  this button disappears before it can be clicked)
                                onMouseDown={() => {
                                    this.props.addPicked(option.value);
                                }}
                            >
                                + {option.label}
                            </button>
                        ))}
                        {extra > 0 && (
                            <button className={css.hbox(5).button} disabled>
                                + {extra} more...
                            </button>
                        )}
                    </div>
                )}
                <div className={css.hbox(4).wrap}>
                    {pickedOptions.map((option) => (
                        <button
                            key={`remove-${option.matchText}`}
                            className={css.hbox(5).button + yellowButton}
                            onMouseDown={() => {
                                this.props.removePicked(option.value);
                            }}
                        >
                            - {option.label}
                        </button>
                    ))}
                </div>
            </div>
        );
    }
}