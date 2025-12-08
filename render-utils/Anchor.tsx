import preact from "preact";
import { URLParam, batchURLParamUpdate, getResolvedParam } from "./URLParam";
import { css, isNode } from "typesafecss";

export const AnchorClass = (
    css.textDecoration("none").color("hsl(210, 75%, 65%)").opacity(0.8, "hover")
);

export class Anchor extends preact.Component<{
    className?: string;
    params: ([URLParam, unknown] | [string, string])[];
    button?: boolean;
} & Omit<preact.JSX.HTMLAttributes<HTMLAnchorElement>, "href">> {
    render() {
        const { params, button, className, ...remaining } = this.props;
        let resolvedParams = params.map(getResolvedParam);
        let searchObj = new URLSearchParams(window.location.search);
        let selected = resolvedParams.every(([param, value]) => searchObj.get(param) === value);
        let link = (
            <a
                {...remaining}
                className={
                    css.textDecoration("none")
                        .opacity(0.8, "hover")
                    + (selected && css.color("hsl(110, 75%, 65%)", "soft"))
                    + (!selected && css.color("hsl(210, 75%, 65%)", "soft"))
                    + className
                }
                href={createLink(resolvedParams)}
                onClick={e => {
                    if (this.props.target) return;
                    e.preventDefault();
                    e.stopPropagation();
                    batchURLParamUpdate(params);
                }}
            >
                {this.props.children}
            </a>
        );
        if (button) {
            return <button className={css.button} onClick={() => {
                batchURLParamUpdate(params);
            }}>
                {link}
            </button>;
        }
        return link;
    }
}

function createLink(params: ([string, string])[]) {
    let searchParams = new URLSearchParams(isNode() ? "https://planquickly.com" : window.location.search);
    for (let [param, value] of params) {
        searchParams.set(param, value);
    }
    return "?" + searchParams.toString();
}

export function createLinkRaw(params: ([URLParam, unknown])[]) {
    let paramsText = params.map(getResolvedParam);
    return createLink(paramsText);
}