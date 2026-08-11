#!/usr/bin/env node
"use strict";
// Sends one message to a webhook, to prove notifications work.
require("typenode");

require("../security/notifications/testNotify").main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
