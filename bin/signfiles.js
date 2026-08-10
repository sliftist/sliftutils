#!/usr/bin/env node
"use strict";
// Signs the files of the repo in the current directory, so a machine pulling it can tell who
// published what it is about to trust.
require("typenode");

require("../security/signedFiles/signFiles").main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
