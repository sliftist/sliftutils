#!/usr/bin/env node
"use strict";
// Same as filehoster, but also compacts the hosted bulk databases on startup and every 3h, so remote
// clients (which skip compaction by default) don't have to.
require("typenode");
process.argv.push("--autocompact");
require("../storage/remoteFileServer").runFileHoster();
