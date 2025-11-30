import preact from "preact";
import { LengthOrPercentage } from "typesafecss/cssTypes";
export declare class DropdownCustom<T> extends preact.Component<{
    class?: string;
    optionClass?: string;
    title?: string;
    value: T;
    onChange: (value: T, index: number) => void;
    maxWidth?: LengthOrPercentage;
    options: {
        value: T;
        label: (isOpen: boolean) => preact.ComponentChild;
    }[];
}> {
    synced: {
        isOpen: boolean;
        tempIndexSelected: number | null;
    };
    onUnmount: (() => void)[];
    componentDidMount(): void;
    componentDidUnmount(): void;
    render(): preact.JSX.Element;
}
