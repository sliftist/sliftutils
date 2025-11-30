import * as preact from "preact";
import { Reaction } from "mobx";
export declare function observer<T extends {
    new (...args: any[]): {
        render(): preact.ComponentChild;
        forceUpdate(callback?: () => void): void;
        componentWillUnmount?(): void;
    };
}>(Constructor: T): {
    new (...args: any[]): {
        reaction: Reaction;
        componentWillUnmount(): void;
        render(...args: any[]): preact.ComponentChild;
        forceUpdate(callback?: () => void): void;
    };
    readonly name: string;
} & T;
