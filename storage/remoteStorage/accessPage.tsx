process.env.NODE_ENV = "production";

import preact from "preact";
import { observable } from "mobx";
import { observer } from "../../render-utils/observer";
import { isNode } from "socket-function/src/misc";
import { css } from "typesafecss";
import { SocketFunction } from "socket-function/SocketFunction";
import { RemoteStorageController, AccessState, AccessRequest } from "./storageController";
import { authenticateStorage } from "./ArchivesRemote";

// The storage server's access page. Visit https://<storageDomain>:<port>/<accountName> to request access to that account for this browser's machine identity. Once granted, lists the machines that have access. To approve someone else's request, the user must type in the requester's IP — pending requests are NEVER shown unsolicited (so a trusted user can't accidentally approve a random machine's request).

const REFRESH_INTERVAL = 1000 * 15;
const COPIED_RESET_DELAY = 2000;

@observer
class CopyableCommand extends preact.Component<{ command: string }> {
    synced = observable({
        copied: false,
    });

    render() {
        let command = this.props.command;
        return <div className={css.hbox(8).alignItems("flex-start")}>
            <button onClick={async () => {
                await navigator.clipboard.writeText(command);
                this.synced.copied = true;
                setTimeout(() => { this.synced.copied = false; }, COPIED_RESET_DELAY);
            }}>
                {this.synced.copied && "Copied!" || "Copy"}
            </button>
            <code className={css.fontFamily("monospace").whiteSpace("pre-wrap")
                .hsl(0, 0, 92).pad2(8, 4).borderRadius(4)
            }>
                {command}
            </code>
        </div>;
    }
}

@observer
class AccessPage extends preact.Component {
    synced = observable({
        account: "",
        state: undefined as AccessState | undefined,
        error: "",
        lookupIp: "",
        lookupResults: undefined as { ip: string; requests: AccessRequest[] } | undefined,
        lookupError: "",
        looking: false,
        granting: "",
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
    private async controller() {
        let address = location.hostname;
        let port = +location.port || 443;
        let nodeId = SocketFunction.connect({ address, port });
        if (!this.authenticated) {
            await authenticateStorage({ address, port, nodeId });
            this.authenticated = true;
        }
        return RemoteStorageController.nodes[nodeId];
    }
    private async refresh(account: string) {
        let controller = await this.controller();
        await controller.requestAccess({ account });
        this.synced.state = await controller.getAccessState({ account });
        this.synced.error = "";
    }

    private lookupIP = async () => {
        let ip = this.synced.lookupIp.trim();
        if (!ip) return;
        this.synced.looking = true;
        this.synced.lookupError = "";
        try {
            let controller = await this.controller();
            let requests = await controller.listRequestsForIP({ account: this.synced.account, ip });
            this.synced.lookupResults = { ip, requests };
        } catch (e) {
            this.synced.lookupError = String(e);
        } finally {
            this.synced.looking = false;
        }
    };

    private approve = async (request: AccessRequest) => {
        this.synced.granting = request.requestId;
        try {
            let controller = await this.controller();
            await controller.grantAccess({ requestId: request.requestId });
            if (this.synced.lookupResults) {
                this.synced.lookupResults.requests = this.synced.lookupResults.requests.filter(r => r.requestId !== request.requestId);
            }
            await this.refresh(this.synced.account);
        } catch (e) {
            this.synced.lookupError = String(e);
        } finally {
            this.synced.granting = "";
        }
    };

    render() {
        let synced = this.synced;
        let { account, state, error } = synced;
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
                <div>An access request has been made. To grant it, run this command:</div>
                {state.grantAccessCommand && <CopyableCommand command={state.grantAccessCommand} />}
                <div>This page rechecks every {REFRESH_INTERVAL / 1000} seconds.</div>
            </div>}
            {state && state.hasAccess && <div className={css.vbox(16)}>
                <div>This machine ({state.machineId}, ip {state.ip}) has access.</div>
                <div className={css.vbox(6)}>
                    <div>Machines with access:</div>
                    <table>
                        <thead>
                            <tr>
                                <th className={css.pad2(8, 2).textAlign("left")}>Machine</th>
                                <th className={css.pad2(8, 2).textAlign("left")}>IP</th>
                                <th className={css.pad2(8, 2).textAlign("left")}>Granted</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(state.trustedMachines || []).map(m => <tr key={m.machineId}>
                                <td className={css.pad2(8, 2)}>{m.machineId}</td>
                                <td className={css.pad2(8, 2)}>{m.ip}</td>
                                <td className={css.pad2(8, 2)}>{new Date(m.time).toLocaleString()}</td>
                            </tr>)}
                        </tbody>
                    </table>
                </div>
                <div className={css.vbox(6)}>
                    <div>Approve request</div>
                    <div className={css.hbox(8).alignItems("center")}>
                        <input
                            placeholder="ip"
                            value={synced.lookupIp}
                            onInput={e => { synced.lookupIp = (e.currentTarget as HTMLInputElement).value; }}
                            onKeyDown={e => { if (e.key === "Enter") void this.lookupIP(); }}
                        />
                        <button disabled={synced.looking || !synced.lookupIp.trim()} onClick={this.lookupIP}>
                            search
                        </button>
                    </div>
                    {synced.lookupError && <div>Error: {synced.lookupError}</div>}
                    {synced.lookupResults && synced.lookupResults.requests.length === 0 && <div>
                        No pending requests for {synced.lookupResults.ip} on this account.
                    </div>}
                    {synced.lookupResults && synced.lookupResults.requests.length > 0 && <table>
                        <thead>
                            <tr>
                                <th className={css.pad2(8, 2).textAlign("left")}>Machine</th>
                                <th className={css.pad2(8, 2).textAlign("left")}>IP</th>
                                <th className={css.pad2(8, 2).textAlign("left")}>Requested</th>
                                <th className={css.pad2(8, 2).textAlign("left")}></th>
                            </tr>
                        </thead>
                        <tbody>
                            {synced.lookupResults.requests.map(r => <tr key={r.requestId}>
                                <td className={css.pad2(8, 2)}>{r.machineId}</td>
                                <td className={css.pad2(8, 2)}>{r.ip}</td>
                                <td className={css.pad2(8, 2)}>{new Date(r.time).toLocaleString()}</td>
                                <td className={css.pad2(8, 2)}>
                                    <button disabled={!!synced.granting} onClick={async () => this.approve(r)}>
                                        {synced.granting === r.requestId && "Approving..." || "Approve"}
                                    </button>
                                </td>
                            </tr>)}
                        </tbody>
                    </table>}
                </div>
            </div>}
        </div>;
    }
}

async function main() {
    if (isNode()) return;
    preact.render(<AccessPage />, document.body);
}

main().catch(console.error);
