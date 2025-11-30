import * as preact from "preact";
import { observable, Reaction } from "mobx";

let globalConstructOrder = 1;
export function observer<
    T extends {
        new(...args: any[]): {
            render(): preact.ComponentChild;
            forceUpdate(callback?: () => void): void;
            componentWillUnmount?(): void;
        }
    }
>(
    Constructor: T
) {
    let name = Constructor.name;
    return class extends Constructor {
        // @ts-ignore
        static get name() { return Constructor.name; }
        reaction = new Reaction(`render.${name}.${globalConstructOrder++}`, () => {
            super.forceUpdate();
        });
        componentWillUnmount() {
            this.reaction.dispose();
            super.componentWillUnmount?.();
        }
        render(...args: any[]) {
            let output: preact.ComponentChild;
            this.reaction.track(() => {
                output = (super.render as any)(...args);
            });
            return output;
        }
    };
}