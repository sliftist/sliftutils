#!/usr/bin/env node
"use strict";
// Answers whether the machine asking is trusted, from the address it is asking from.
require("typenode");

// No exit on success: this one is a server, and returning from main only means it is listening.
require("../security/machines/trustServer").main().catch(e => {
    console.error(`${e}`);
    process.exit(1);
});
