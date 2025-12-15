import preact from "preact";
import { cache, lazy } from "socket-function/src/caching";
import { css, isNode } from "typesafecss";
import fs from "fs";
import os from "os";
import { observable } from "mobx";
import { InputLabel } from "../render-utils/InputLabel";
import { showModal } from "../render-utils/modal";
import { observer } from "../render-utils/observer";

@observer
class DirectoryPrompter extends preact.Component<{
    valueKey: string;
    onDone: (value: string) => void;
}> {
    synced = observable({
        value: "",
    });
    render() {
        const { valueKey, onDone } = this.props;
        const { value } = this.synced;
        return (
            <div className={
                css.position("fixed").pos(0, 0).size("100vw", "100vh")
                    .zIndex(1)
                    .hsla(0, 0, 20, 0.5)
                    .center
                    .fontSize(40)
            }>
                <InputLabel
                    label={valueKey}
                    value={value}
                    onChangeValue={value => this.synced.value = value}
                />
                <button onClick={() => onDone(value)}>
                    Done
                </button>
            </div>
        );
    }
}


function getStorageKey(key: string) {
    if (isNode()) return os.homedir() + "/" + key;
    return `apiKeys.ts_${key}`;
}

let state = observable({
    keys: [] as string[],
});
if (!isNode()) {
    try {
        let newKeys = JSON.parse(localStorage.getItem(getStorageKey("__keys"))!);
        if (Array.isArray(newKeys)) {
            state.keys = newKeys;
        }
    } catch { }
}

@observer
export class APIKeysControl extends preact.Component {
    render() {
        return (
            <label className={css.hbox(4)}>
                <span>Keys:</span>
                <select>
                    {state.keys.map(key =>
                        <option>{key}</option>
                    )}
                </select>
                <button onClick={() => {
                    let key = state.keys[0];
                    state.keys = state.keys.filter(k => k !== key);
                    localStorage.setItem(getStorageKey("__keys"), JSON.stringify(state.keys));
                    localStorage.removeItem(getStorageKey(key));
                }}>
                    Delete
                </button>
            </label>
        );
    }
}

let getStorage = lazy((): {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
} => {
    if (!isNode()) return localStorage;
    return {
        getItem: (key) => {
            if (!fs.existsSync(key)) return null;
            return fs.readFileSync(key, "utf-8");
        },
        setItem: (key, value) => {
            fs.writeFileSync(key, value);
        },
    };
});

export const getAPIKey = cache(async function getAPIKey(key: string): Promise<string> {
    let keyKey = getStorageKey(key);
    let localStorageValue = getStorage().getItem(keyKey);
    if (localStorageValue?.startsWith("{")) {
        try {
            localStorageValue = JSON.parse(localStorageValue).key;
        } catch { }
    }
    if (localStorageValue) {
        return localStorageValue;
    }
    if (isNode()) throw new Error(`Add an api key to ${keyKey}`);

    let onDone = (value: string) => { };
    let promise = new Promise<string>(resolve => {
        onDone = resolve;
    });
    let obj = showModal({ contents: <DirectoryPrompter valueKey={key} onDone={onDone} /> });
    try {
        let value = await promise;

        getStorage().setItem(keyKey, value);
        state.keys.push(key);
        getStorage().setItem(getStorageKey("__keys"), JSON.stringify(state.keys));
        return value;
    } finally {
        obj.close();
    }
});

@observer
export class ManageAPIKeys extends preact.Component {
    render() {
        return "ManageAPIKeys";
    }
}