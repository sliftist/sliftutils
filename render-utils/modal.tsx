import preact from "preact";
import { observable } from "mobx";
import * as mobx from "mobx";
import { observer } from "./observer";
import { lazy } from "socket-function/src/caching";
import { nextId } from "socket-function/src/misc";

type ModalData = {
    contents: preact.ComponentChildren;
    onClose?: () => void;
};

const activeModals = observable({} as { [key: string]: ModalData }, undefined, { deep: false });

@observer
class ModalRoot extends preact.Component {
    render() {
        const modals: Array<[string, ModalData]> = Object.entries(activeModals);
        return <div style={{ position: "relative", zIndex: 1 }}>
            {modals.map(([id, data]) => (
                <div key={id}>
                    {data.contents}
                </div>
            ))}
        </div>;
    }
}

const ensureRootMounted = lazy(() => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    preact.render(<ModalRoot />, root);
});


function closeModal(id: string) {
    const modal = activeModals[id];
    if (!modal) {
        return;
    }

    delete activeModals[id];

    if (modal.onClose) {
        modal.onClose();
    }
}

export function showModal(config: {
    contents: preact.ComponentChildren;
    onClose?: () => void;
}): {
    close: () => void;
} {
    ensureRootMounted();

    const id = `modal-${nextId()}`;
    activeModals[id] = {
        contents: config.contents,
        onClose: config.onClose
    };

    return {
        close() {
            closeModal(id);
        }
    };
}

export function closeAllModals() {
    // for (let key in activeModals) {
    //     closeModal(key);
    // }
    // Actually, just close the last opened modal
    const keys = Object.keys(activeModals);
    if (keys.length > 0) {
        closeModal(keys[keys.length - 1]);
    }
}