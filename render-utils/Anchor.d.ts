import preact from "preact";
import { URLParam } from "./URLParam";
export declare class Anchor extends preact.Component<{
    className?: string;
    params: ([URLParam, unknown] | [string, string])[];
    button?: boolean;
} & Omit<preact.JSX.HTMLAttributes<HTMLAnchorElement>, "href">> {
    render(): preact.JSX.Element;
}
export declare function createLinkRaw(params: ([URLParam, unknown])[]): string;
