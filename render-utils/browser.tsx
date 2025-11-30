import * as preact from "preact";
import { observable } from "mobx";
import { observer } from "./observer";
import { isNode } from "typesafecss";

@observer
class App extends preact.Component {
    synced = observable({
        count: 0,
    });

    render() {
        return (
            <div>
                <h1>Hello from Web!</h1>
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
    preact.render(<App />, document.getElementById("app")!);
}

main().catch(console.error);

