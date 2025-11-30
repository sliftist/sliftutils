import { observer } from "./observer";
import * as preact from "preact";
import { css } from "typesafecss";

@observer
export class SyncedLoadingIndicator extends preact.Component<{
    controller: { anyPending: () => boolean };
}> {
    render() {
        let { controller } = this.props;
        let pending = controller.anyPending();
        if (!pending) return null;

        return <div className={css.hbox(8).pad2(12).hsl(220, 50, 20).bord2(220, 50, 40, 1).borderRadius(6)}>
            <style>
                {`
                @keyframes syncSpin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                .sync-spinner {
                    animation: syncSpin 1s linear infinite;
                }
                @keyframes syncPulse {
                    0%, 100% { opacity: 0.6; }
                    50% { opacity: 1; }
                }
                .sync-pulse {
                    animation: syncPulse 1.5s ease-in-out infinite;
                }
                `}
            </style>
            <div className={css.size(16, 16).bord2(220, 60, 70, 2).borderRadius(50).borderTopColor("transparent") + " sync-spinner"}></div>
            <div className={css.colorhsl(220, 60, 80).fontSize(14) + " sync-pulse"}>Syncing...</div>
        </div>;
    }
}
