#!/usr/bin/env node
"use strict";
// The daemon that keeps a machine's root authorized_keys equal to its key repos. Installed and
// started by securessh, and normally only run by systemd.
require("typenode");
require("../security/authorizedKeys/daemon/daemon");
