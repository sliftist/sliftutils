import preact from "preact";
import { InputProps } from "./Input";
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
