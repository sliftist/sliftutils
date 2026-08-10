#!/usr/bin/env node
"use strict";
// Manages which repos a host takes its root authorized_keys from, and installs the daemon that
// keeps them applied.
require("typenode");

require("../security/authorizedKeys/secureSSH").main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
