#!/usr/bin/env node
"use strict";
// Undoes revocations, by writing a file into the keys repo naming the ones to undo.
require("typenode");
require("../security/authorizedKeys/unrevokeCli");
