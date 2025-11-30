import * as preact from "preact";
import { observable } from "mobx";
import { observer } from "../render-utils/observer";
import { css, isNode } from "typesafecss";
import { list } from "socket-function/src/misc";

@observer
class App extends preact.Component {
    synced = observable({
        count: 0,
    });

    render() {
        return (
            <div className={css.pad2(20)}>
                <h1>Hello from Web!</h1>
                <p>Count: {this.synced.count}</p>
                <button onClick={() => this.synced.count++}>
                    Increment
                </button>
                <div>
                    {list(1000).map(x => <div key={x}>{x}</div>)}
                </div>
            </div>
        );
    }
}

async function main() {
    if (isNode()) return;
    preact.render(<App />, document.getElementById("app")!);
}

main().catch(console.error);

