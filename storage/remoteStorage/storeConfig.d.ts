import { HostedConfig } from "../IArchives";
export declare class StoreConfig {
    readonly name: string;
    constructor(name: string, entries: HostedConfig[]);
    private entries;
    /** The routing config changed. Same store either way: its name did not change, so neither did its folder, its index, or the data in it. */
    /** No entries is a real state, not an error: a store exists as soon as its folder does, and it may never have heard of a configuration (see StorePolicy). */
    update(entries: HostedConfig[]): void;
    all(): HostedConfig[];
    /**
     * What this store is configured to be right now: the entry whose window contains this moment;
     * failing that the next one due to start; failing that the last one to have ended.
     *
     * There is always an answer, and it matters that there is: a store between windows still holds
     * data and still has to answer for it, so it needs a route and flags even when nothing is
     * currently pointing writes at it. Which of the three cases produced the answer is deliberately
     * not exposed - the valid window itself is what says whether writes belong here, and every write
     * is checked against it separately.
     */
    current(): StorePolicy;
}
/** The parts of a config entry that describe what a store IS - as opposed to which entry said so. Kept separate because a store with no entries still has all of them. */
export type StorePolicy = {
    validWindow: [number, number];
    route?: [number, number];
    public?: boolean;
    immutable?: boolean;
    fast?: boolean;
    writeDelay?: number;
    noFullSync?: boolean;
    readerDiskLimit?: number;
};
