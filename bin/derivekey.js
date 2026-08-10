#!/usr/bin/env node
"use strict";
// Derives a second ed25519 key from an existing one, so one key can stand behind several
// identities without any of them being stored.
require("typenode");

require("../security/keys/deriveKey").main().catch(e => {
    console.error(`${e}`);
    process.exitCode = 1;
}).finally(() => process.exit());
