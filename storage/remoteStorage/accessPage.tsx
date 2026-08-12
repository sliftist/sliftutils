process.env.NODE_ENV = "production";

import preact from "preact";
import { observable } from "mobx";
import { observer } from "../../render-utils/observer";
import { isNode } from "socket-function/src/misc";
import { css } from "typesafecss";
import { SocketFunction } from "socket-function/SocketFunction";
import { RemoteStorageController, AccessState } from "./storageController";
import { authenticateStorage } from "./ArchivesRemote";

// The storage server's access page. Visit https://<storageDomain>:<port>/<accountName> to see whether this browser's machine identity has access, and if not, the one command that grants it. Nothing is requested or approved here: trust lives in the signed authorized_keys repo, so access is granted by someone running addmachine there with the hardware key, and this page only reports what that repo says.

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
        this.synced.state = await controller.getAccessState({ account });
        this.synced.error = "";
    }

    render() {
        let synced = this.synced;
        let { account, state, error } = synced;
        if (!account) {
            return <div className={css.vbox(8).pad2(16)}>
                <div>Remote storage server.</div>
                <div>Visit /(account name) to see whether this browser's machine has access to an account.</div>
            </div>;
        }
        return <div className={css.vbox(12).pad2(16)}>
            <div>Storage account: {account}</div>
            {error && <div>Error: {error}</div>}
            {!state && !error && <div>Checking access...</div>}
            {state && !state.hasAccess && <div className={css.vbox(8)}>
                <div>This machine ({state.machineId}, ip {state.ip}) does NOT have access.</div>
                {state.reason && <div>{state.reason}</div>}
                <div>Run this in the authorized_keys repo, on a machine with the signing key:</div>
                {state.addMachineCommand && <CopyableCommand command={state.addMachineCommand} />}
                <div>This page rechecks every {REFRESH_INTERVAL / 1000} seconds.</div>
            </div>}
            {state && state.hasAccess && <div className={css.vbox(16)}>
                <div>This machine ({state.machineId}, ip {state.ip}) has access.</div>
                <div className={css.vbox(6)}>
                    <div>Trusted machines:</div>
                    <table>
                        <thead>
                            <tr>
                                <th className={css.pad2(8, 2).textAlign("left")}>Machine</th>
                                <th className={css.pad2(8, 2).textAlign("left")}>Allowed from</th>
                                <th className={css.pad2(8, 2).textAlign("left")}>Added</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(state.trustedMachines || []).map(m => <tr key={m.machineId}>
                                <td className={css.pad2(8, 2)}>{m.machineId}</td>
                                <td className={css.pad2(8, 2)}>{m.ips.join(", ")}</td>
                                <td className={css.pad2(8, 2)}>{m.addedAt}</td>
                            </tr>)}
                        </tbody>
                    </table>
                </div>
            </div>}
        </div>;
    }
}

// Reached via the cert-trust flow (showCertTrustModal links here as ?trustCert=1). The browser only loads this page if it has ACCEPTED the certificate - so the mere fact that it rendered is the confirmation. Once accepted, the app's background connection to this same server works, so the user just returns.
function CertTrustedPage() {
    return <div className={css.vbox(8).pad2(16)}>
        <div>This server's certificate is now trusted by this browser.</div>
        <div>Close this tab and return to the page you came from - it will connect to the storage server automatically.</div>
    </div>;
}

async function main() {
    if (isNode()) return;
    if (new URLSearchParams(location.search).has("trustCert")) {
        preact.render(<CertTrustedPage />, document.body);
        return;
    }
    preact.render(<AccessPage />, document.body);
}

main().catch(console.error);
