import preact from "preact";
import { observable } from "mobx";
import { observer } from "./observer";
import { css } from "typesafecss";
import { LengthOrPercentage, LengthOrPercentageOrAuto } from "typesafecss/cssTypes";


@observer
export class DropdownCustom<T> extends preact.Component<{
    class?: string;
    optionClass?: string;
    title?: string;
    value: T;
    onChange: (value: T, index: number) => void;
    maxWidth?: LengthOrPercentage;
    options: { value: T; label: (isOpen: boolean) => preact.ComponentChild; }[];
}> {
    synced = observable({
        isOpen: false,
        tempIndexSelected: null as null | number,
    });
    onUnmount: (() => void)[] = [];
    componentDidMount(): void {
        const handler = (e: MouseEvent) => {
            if (!this.synced.isOpen) return;
            let el = e.target as HTMLElement | null;
            while (el) {
                if (el === this.base) return;
                el = el.parentElement;
            }
            this.synced.isOpen = false;
        };
        window.addEventListener("click", handler);
        this.onUnmount.push(() => window.removeEventListener("click", handler));
    }
    componentDidUnmount(): void {
        for (let f of this.onUnmount) f();
    }
    render() {
        const { options, value, title, onChange } = this.props;
        let selectedIndex = options.findIndex(o => o.value === value);
        if (selectedIndex === -1) selectedIndex = 0;
        let selectedItem = options[selectedIndex] || { value: undefined, label: () => { } };

        let renderOptions = () => {
            let selIndex = this.synced.tempIndexSelected ?? selectedIndex;
            return (
                <div className={css.absolute.width(this.props.maxWidth || "50vw")}>
                    <button
                        className={css.opacity(0).visibility("hidden").absolute}
                        data-hotkey={"Enter"}
                        onClick={() => {
                            if (this.synced.tempIndexSelected !== null) {
                                this.props.onChange(options[this.synced.tempIndexSelected].value, this.synced.tempIndexSelected);
                            }
                            this.synced.isOpen = false;
                            this.synced.tempIndexSelected = null;
                        }}
                    />
                    <button
                        className={css.opacity(0).visibility("hidden").absolute}
                        data-hotkey={"ArrowUp"}
                        onClick={(e) => {
                            e.stopPropagation();
                            this.synced.tempIndexSelected = (this.synced.tempIndexSelected ?? selectedIndex) - 1;
                            if (this.synced.tempIndexSelected < 0) this.synced.tempIndexSelected = options.length - 1;
                        }}
                    />
                    <button
                        className={css.opacity(0).visibility("hidden").absolute}
                        data-hotkey={"ArrowDown"}
                        onClick={(e) => {
                            e.stopPropagation();
                            this.synced.tempIndexSelected = (this.synced.tempIndexSelected ?? selectedIndex) + 1;
                            if (this.synced.tempIndexSelected >= options.length) this.synced.tempIndexSelected = 0;
                        }}
                    />
                    <div
                        className={
                            css.pad(2).margin(2)
                                .absolute.pos(0, 0).zIndex(1)
                                .hsl(0, 0, 25)
                                .vbox(2).alignItems("stretch")
                                .overflow("auto")
                                .maxHeight("50vh")
                                .border("1px solid hsl(0, 0%, 10%)")
                            + this.props.optionClass
                        }
                    >
                        {this.props.options.map(({ value, label }, index, list) =>
                            <>
                                {index !== 0 &&
                                    <div className={css.height(1).hsl(0, 0, 20)} />
                                }
                                <div
                                    onClick={() => {
                                        this.props.onChange(value, index);
                                        this.synced.isOpen = false;
                                        this.synced.tempIndexSelected = null;
                                    }}
                                    className={
                                        " "
                                        + (
                                            index === selIndex && css.hsl(0, 0, 40)
                                            || index % 2 === 0 && css.hsl(0, 0, 25)
                                            || index % 2 === 1 && css.hsl(0, 0, 20)
                                            || ""
                                        )
                                        + css.button.pad(2, 6)
                                        + css.background("hsl(0, 0%, 60%)", "hover")
                                        + this.props.optionClass
                                    }
                                >
                                    {label(true)}
                                </div>
                            </>
                        )}
                    </div>
                </div >
            );
        };

        return (
            <div
                className={(this.synced.isOpen && css.zIndex(1)) + (this.props.class || "")}
            >
                {this.props.title && (
                    <div
                        style={{
                            fontWeight: "bold",
                        }}
                        onClick={() => this.synced.isOpen = !this.synced.isOpen}
                    >
                        {this.props.title}
                    </div>
                )}
                <div className={css.relative.vbox0.maxWidth(this.props.maxWidth)}>
                    <div
                        className={css.hbox(10).hsl(0, 0, 25).pad(4, 10).button + this.props.optionClass}
                        onClick={() => this.synced.isOpen = !this.synced.isOpen}
                    >
                        {selectedItem?.label(false)}
                        <button>Expand</button>
                    </div>
                    {this.synced.isOpen && renderOptions()}
                </div>
            </div>
        );
    }
}