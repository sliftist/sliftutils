#!/usr/bin/env node
"use strict";
// Undoes revocations, by writing a file into the keys repo naming the ones to undo.
require("typenode");

require("../security/authorizedKeys/unrevoke").main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
