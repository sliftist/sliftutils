#!/usr/bin/env node
"use strict";
// Adds a machine to the trusted list in a keys repo, this one or one reached over ssh.
require("typenode");

require("../security/machines/addMachine").main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
