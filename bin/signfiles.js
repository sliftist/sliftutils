#!/usr/bin/env node
"use strict";
// Signs the files of a keys repo, so a machine pulling it can tell who published what it trusts.
require("typenode");
require("../security/signedFiles/signFilesCli");
