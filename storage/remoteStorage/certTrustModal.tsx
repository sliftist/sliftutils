import preact from "preact";
import { isNode } from "socket-function/src/misc";
import { css } from "typesafecss";

// Shown in the browser when we can't establish a connection to a storage server - most often because it serves a self-signed certificate (see --selfSigned) that this browser has not accepted yet. Gives the user a link to the server, where the browser lets them accept the certificate (the ?trustCert=1 page, see accessPage.tsx); once accepted, the app's own background connection to that server starts working. A no-op in Node.

// One modal per server origin, so repeated connection failures (there are many, on a retry loop) never stack modals
const shownForOrigin = new Set<string>();

export function showCertTrustModal(serverUrl: string): void {
    if (isNode()) return;
    let origin: string;
    try {
        origin = new URL(serverUrl).origin;
    } catch {
        return;
    }
    if (shownForOrigin.has(origin)) return;
    shownForOrigin.add(origin);

    let container = document.createElement("div");
    document.body.appendChild(container);
    let close = () => {
        preact.render(null, container);
        container.remove();
        // Leave it in shownForOrigin: the user dismissed it, so don't re-pop it on the next failure of the same server
    };
    preact.render(<CertTrustModal origin={origin} onClose={close} />, container);
}

function CertTrustModal(props: { origin: string; onClose: () => void }) {
    // Loading this page at all means the browser accepted the certificate; the page then tells the user they can come back
    let trustUrl = props.origin + "/?trustCert=1";
    return <div className={css.fixed.pos(0, 0).fillBoth.zIndex(2147483647)
        .hbox(0).justifyContent("center").alignItems("center").hsla(0, 0, 0, 0.5)
    }>
        <div className={css.vbox(12).pad2(24).maxWidth(480).hsl(0, 0, 100).borderRadius(8)}>
            <div>Can't reach the storage server at <code>{props.origin}</code>.</div>
            <div>
                If this server uses a self-signed certificate, the browser blocks the connection until you accept it. Open the server below, accept the certificate warning, then return to this page - it will connect automatically.
            </div>
            <a href={trustUrl} target="_blank" rel="noreferrer">Open {props.origin} and trust its certificate</a>
            <div className={css.hbox(8).justifyContent("flex-end")}>
                <button onClick={props.onClose}>Close</button>
            </div>
        </div>
    </div>;
}
