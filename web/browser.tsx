import * as preact from "preact";
import { observable } from "mobx";
import { observer } from "../render-utils/observer";
import { css, isNode } from "typesafecss";
import { list } from "socket-function/src/misc";
import { enableHotReloading } from "../builders/hotReload";
import { URLParam } from "../render-utils/URLParam";
import { Page } from "./Page";
import { configureMobxNextFrameScheduler } from "sliftutils/render-utils/mobxTyped";


async function main() {
    if (isNode()) return;
    await enableHotReloading({ port: 9877 });
    configureMobxNextFrameScheduler();
    preact.render(<Page />, document.getElementById("app")!);
}

main().catch(console.error);

