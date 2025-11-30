import * as preact from "preact";
import { observable } from "mobx";
import { observer } from "../render-utils/observer";
import { isNode } from "typesafecss";
import { enableHotReloading } from "../builders/hotReload";

@observer
class App extends preact.Component {
    synced = observable({
        count: 0,
    });

    render() {
        return (
            <div>
                <h1>Hello from Electron!</h1>
                <p>Count: {this.synced.count}</p>
                <button onClick={() => this.synced.count++}>
                    Increment
                </button>
            </div>
        );
    }
}

async function main() {
    if (isNode()) return;
    await enableHotReloading({ port: 9879 });
    preact.render(<App />, document.getElementById("app")!);
}

main().catch(console.error);

