import preact from "preact";
import { css } from "typesafecss";
import { Anchor } from "../render-utils/Anchor";
import { URLParam } from "../render-utils/URLParam";
import { observer } from "../render-utils/observer";
import { ExamplePage } from "./ExamplePage";

export const pageURL = new URLParam("page");

@observer
export class Page extends preact.Component {
    onKeyDown = (e: KeyboardEvent) => {
        // Ignore if it is for an input, text area, etc
        let ignore = (
            e.target instanceof HTMLInputElement && e.target.type !== "file" ||
            e.target instanceof HTMLTextAreaElement ||
            e.target instanceof HTMLSelectElement
        );
        if (ignore) return;

        let key = e.key;
        if (e.ctrlKey) key = "Ctrl+" + key;
        if (e.shiftKey) key = "Shift+" + key;
        let hotkeyDataAttribute = `[data-hotkey="${key}"]`;
        let el = document.querySelector<HTMLElement>(hotkeyDataAttribute);
        if (el) {
            e.stopPropagation();
            e.preventDefault();
            console.log("Found hotkey", e.key, el);
            el.click();
        }
    };
    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }
    render() {
        let pages = [
            {
                key: "example",
                content: <ExamplePage />
            },
        ];

        let page = pages.find(p => p.key === pageURL.value) || pages[0];

        return (
            <div className={css.size("100vw", "100vh").vbox(0)}>
                <div className={css.hbox(12).pad2(20, 0)}>
                    {pages.map(p => (
                        <Anchor key={p.key} params={[[pageURL, p.key]]}>
                            {p.key}
                        </Anchor>
                    ))}
                </div>
                <div className={css.overflowAuto.fillBoth}>
                    {page.content}
                </div>
            </div>
        );
    }
}
