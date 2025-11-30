import preact from "preact";

export function showModal(config: {
    contents: preact.ComponentChildren;
}): {
    close: () => void;
} {
    let root = document.createElement("div");
    document.body.appendChild(root);
    preact.render(config.contents, root);

    return {
        close() {
            preact.render(undefined, root);
            document.body.removeChild(root);
        }
    };
}