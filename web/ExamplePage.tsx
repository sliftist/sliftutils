import { observable } from "mobx";
import { list } from "socket-function/src/misc";
import { css } from "typesafecss";
import { URLParam } from "../render-utils/URLParam";
import { observer } from "../render-utils/observer";
import * as preact from "preact";

const exampleUrlParam = new URLParam("example", "");

@observer
export class ExamplePage extends preact.Component {
    synced = observable({
        count: 0,
    });

    render() {
        return (
            <div className={css.pad2(20)}>
                <h1>Hello from Web! 3</h1>
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