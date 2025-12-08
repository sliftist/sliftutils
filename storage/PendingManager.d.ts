import preact from "preact";
export declare function setPending(group: string, message: string): void;
export declare function hasPending(): boolean;
export declare class PendingDisplay extends preact.Component {
    render(): preact.JSX.Element;
}
