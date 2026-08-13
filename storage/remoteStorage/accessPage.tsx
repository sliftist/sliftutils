process.env.NODE_ENV = "production";

import preact from "preact";
import { isNode } from "socket-function/src/misc";
import { css } from "typesafecss";

// The storage server's fallback page. There is no access-granting page any more: access errors in
// the console say exactly why a machine was refused and the addmachine command that fixes it. This
// only remains for the cert-trust flow (?trustCert=1, see certTrustModal.tsx).

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
    preact.render(<div className={css.vbox(8).pad2(16)}>
        <div>Remote storage server.</div>
        <div>Access is granted by adding a machine to the authorized_keys repo (yarn addmachine). Denied requests print the exact command in their error.</div>
    </div>, document.body);
}

main().catch(console.error);
