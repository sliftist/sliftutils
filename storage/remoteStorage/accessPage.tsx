module.allowclient = true;

import preact from "preact";
import { observable } from "mobx";
import { observer } from "../../render-utils/observer";
import { isNode } from "socket-function/src/misc";
import { css } from "typesafecss";
import { SocketFunction } from "socket-function/SocketFunction";
import { RemoteStorageController, AccessState } from "./storageController";
import { authenticateStorage } from "./ArchivesRemote";

// The storage server's access page. Visit https://<storageDomain>:<port>/<accountName> to request
// access to that account for this browser's machine identity. Shows the command to run on the
// storage machine to grant it, and once granted, the machines with (or requesting) access.

const REFRESH_INTERVAL = 1000 * 15;

@observer
class AccessPage extends preact.Component {
    synced = observable({
        account: "",
        state: undefined as AccessState | undefined,
        error: "",
    });

    componentDidMount() {
        let account = decodeURIComponent(location.pathname.split("/")[1] || "");
        this.synced.account = account;
        if (!account) return;
        void (async () => {
            while (true) {
                try {
                    await this.refresh(account);
                } catch (e) {
                    this.synced.error = String(e);
                }
                if (this.synced.state?.hasAccess) break;
                await new Promise(resolve => setTimeout(resolve, REFRESH_INTERVAL));
            }
        })();
    }

    private authenticated = false;
    private async refresh(account: string) {
        let address = location.hostname;
        let port = +location.port || 443;
        let nodeId = SocketFunction.connect({ address, port });
        let controller = RemoteStorageController.nodes[nodeId];
        if (!this.authenticated) {
            await authenticateStorage({ address, port, nodeId });
            this.authenticated = true;
        }
        await controller.requestAccess(account);
        this.synced.state = await controller.getAccessState(account);
        this.synced.error = "";
    }

    render() {
        let { account, state, error } = this.synced;
        if (!account) {
            return <div className={css.vbox(8).pad2(16)}>
                <div>Remote storage server.</div>
                <div>Visit /(account name) to request access to an account for this browser.</div>
            </div>;
        }
        return <div className={css.vbox(12).pad2(16)}>
            <div>Storage account: {account}</div>
            {error && <div>Error: {error}</div>}
            {!state && !error && <div>Requesting access...</div>}
            {state && !state.hasAccess && <div className={css.vbox(8)}>
                <div>This machine ({state.machineId}, ip {state.ip}) does NOT have access yet.</div>
                <div>An access request has been made. To grant it, run this single command (it sshes into the storage machine):</div>
                <pre>{state.grantAccessCommand || state.listAccessCommand}</pre>
                <div>This page rechecks every {REFRESH_INTERVAL / 1000} seconds.</div>
            </div>}
            {state && state.hasAccess && <div className={css.vbox(8)}>
                <div>This machine ({state.machineId}, ip {state.ip}) has access.</div>
                <div>Machines with or requesting access:</div>
                <table>
                    <thead>
                        <tr>
                            <th>Machine</th>
                            <th>IP</th>
                            <th>Time</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(state.machines || []).map(machine => <tr key={machine.machineId}>
                            <td className={css.pad2(8, 2)}>{machine.machineId}</td>
                            <td className={css.pad2(8, 2)}>{machine.ip}</td>
                            <td className={css.pad2(8, 2)}>{new Date(machine.time).toLocaleString()}</td>
                            <td className={css.pad2(8, 2)}>{machine.trusted && "has access" || "requesting access"}</td>
                        </tr>)}
                    </tbody>
                </table>
            </div>}
        </div>;
    }
}

async function main() {
    if (isNode()) return;
    preact.render(<AccessPage />, document.body);
}

main().catch(console.error);
