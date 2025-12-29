import preact from "preact";
import { observer } from "./observer";
import { css } from "typesafecss";

@observer
export class ButtonSelector<T> extends preact.Component<{
    title?: string;
    value: T;
    options: { value: T; title: preact.ComponentChild; isDefault?: boolean; hotkeys?: string[] }[];
    onChange: (value: T) => void;
    noPadding?: boolean;
    noDefault?: boolean;
    noUI?: boolean;

    classWrapper?: string;
}> {
    render() {
        const { options, onChange, title } = this.props;
        const selectedValue = this.props.value;
        let selectedOption = (
            options.find(o => o.value === selectedValue)
            || (!this.props.noDefault ? (options.find(o => o.isDefault) || options[0]) : undefined)
        )?.value;
        return (
            <div className={css.hbox(2).wrap + this.props.classWrapper}>
                {title && <div
                    className={
                        css.fontWeight("bold")
                            .hsl(0, 0, 25)
                            .border("1px solid hsl(0, 0%, 5%)").pad(4, 6)
                            .color("white")
                    }
                    title={String(selectedValue)}
                >
                    {title}
                </div>}
                {options.map(({ value, title, hotkeys }) =>
                    <button
                        style={{
                            background: (
                                this.props.noUI && "transparent"
                                || selectedOption === value && "hsl(110, 75%, 40%)"
                                || this.props.noPadding && "hsl(0, 0%, 40%)"
                                || ""
                            ),
                            border: this.props.noUI ? "none" : undefined,
                        }}
                        onClick={() => onChange(value)}
                        className={
                            css.button.flex
                            + ((this.props.noPadding || this.props.noUI) && css.pad(0))
                        }
                        title={String(value)}
                    >
                        {title}
                    </button>
                )}
            </div>
        );
    }
}