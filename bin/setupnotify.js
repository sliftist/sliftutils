#!/usr/bin/env node
"use strict";
// Sets a Discord webhook up on a remote host, so anything on it can raise notifications.
require("typenode");

require("../security/notifications/setupNotify").main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
