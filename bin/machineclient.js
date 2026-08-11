#!/usr/bin/env node
"use strict";
// Asks a server whether this machine is trusted.
require("typenode");

require("../security/machines/trustClient").main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
