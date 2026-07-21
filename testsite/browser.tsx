process.env.NODE_ENV = "production";

import preact from "preact";
import { observable } from "mobx";
import { observer } from "../render-utils/observer";
import { isNode } from "socket-function/src/misc";
import { css } from "typesafecss";
import { SocketFunction } from "socket-function/SocketFunction";
import { ServerInfoController } from "./serverInfoController";

@observer
class TestPage extends preact.Component {
    synced = observable({
        serverOSName: "",
        error: "",
    });

    componentDidMount() {
        void (async () => {
            try {
                let nodeId = SocketFunction.connect({ address: location.hostname, port: +location.port || 443 });
                this.synced.serverOSName = await ServerInfoController.nodes[nodeId].getServerOSName();
            } catch (e) {
                this.synced.error = String(e);
            }
        })();
    }

    render() {
        return <div className={css.vbox(8).pad2(16)}>
            <div>sliftutils hostServer test page</div>
            <div>
                {this.synced.error && `Error: ${this.synced.error}`
                    || this.synced.serverOSName && `Server OS (via SocketFunction): ${this.synced.serverOSName}`
                    || "Asking the server for its OS name..."}
            </div>
        </div>;
    }
}

async function main() {
    if (isNode()) return;
    preact.render(<TestPage />, document.body);
}

main().catch(console.error);
