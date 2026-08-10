#!/usr/bin/env node
"use strict";
// The daemon that keeps a machine's root authorized_keys equal to its key repos. Installed and
// started by securessh, and normally only run by systemd.
//
// Deliberately without the usual finally(process.exit) of the other entry points: this one is
// meant to keep running after main resolves, and exiting there would stop it dead on startup.
require("typenode");

require("../security/authorizedKeys/daemon/daemon").main().catch(e => {
    console.error(`portsecure: failed to start. ${e && e.stack || e}`);
    process.exit(1);
});
