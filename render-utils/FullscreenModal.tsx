import preact from "preact";
import { showModal } from "./modal";
import { observable } from "mobx";
import { observer } from "./observer";

export function showFullscreenModal(config: {
    contents: preact.ComponentChildren;
    onClose?: () => void;
}) {
    let { close } = showModal({
        contents: <FullscreenModal onCancel={() => close()}>
            {config.contents}
        </FullscreenModal>,
        onClose: config.onClose
    });
}

@observer
export class FullscreenModal extends preact.Component<{
    parentState?: { open: boolean };
    onCancel?: () => void;
    style?: preact.JSX.CSSProperties;
    outerStyle?: preact.JSX.CSSProperties;
}> {
    render() {
        let { parentState } = this.props;
        return (
            <div>
                <div style={{ display: "none" }}>
                    <button data-hotkey={"Escape"} onClick={() => {
                        if (parentState) parentState.open = false;
                        this.props.onCancel?.();
                    }}>Close</button>
                </div>
                <div
                    style={{
                        position: "fixed",
                        top: 0,
                        left: 0,
                        width: "100vw",
                        height: "100vh",
                        background: "hsla(0, 0%, 30%, 0.5)",
                        padding: 100,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        overflow: "auto",
                        cursor: "pointer",
                        ...this.props.outerStyle,
                    }}
                    onClick={e => {
                        if (e.currentTarget === e.target) {
                            if (parentState) parentState.open = false;
                            this.props.onCancel?.();
                        }
                    }}
                >
                    <div
                        style={{
                            background: "hsl(0, 0%, 100%)",
                            padding: 20,
                            color: "hsl(0, 0%, 7%)",
                            cursor: "default",
                            width: "100%",
                            display: "flex",
                            flexDirection: "column",
                            gap: 10,
                            maxHeight: "100%",
                            overflow: "auto",
                            ...this.props.style
                        }}
                    >
                        {this.props.children}
                    </div>
                </div>
            </div>
        );
    }
}