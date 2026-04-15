import { isNode } from "socket-function/src/misc";
import { measureFnc } from "socket-function/src/profiling/measure";
import zlib from "zlib";
import * as pako from "pako";

import { setFlag } from "socket-function/require/compileFlags";
import { MaybePromise } from "socket-function/src/types";
import { Zip } from "socket-function/src/Zip";
setFlag(require, "pako", "allowclient", true);

export { Zip };