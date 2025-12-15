import preact from "preact";
export declare class APIKeysControl extends preact.Component {
    render(): preact.JSX.Element;
}
export declare const getAPIKey: {
    (key: string): Promise<string>;
    clear(key: string): void;
    clearAll(): void;
    forceSet(key: string, value: Promise<string>): void;
    getAllKeys(): string[];
    get(key: string): Promise<string> | undefined;
};
export declare class ManageAPIKeys extends preact.Component {
    render(): string;
}
