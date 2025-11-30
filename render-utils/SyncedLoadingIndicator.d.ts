import * as preact from "preact";
export declare class SyncedLoadingIndicator extends preact.Component<{
    controller: {
        anyPending: () => boolean;
    };
}> {
    render(): preact.JSX.Element | null;
}
