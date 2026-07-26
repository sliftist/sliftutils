import { sort } from "socket-function/src/misc";
import { HostedConfig, FULL_VALID_WINDOW } from "../IArchives";

// The configuration of ONE store, kept current. A store is named by its entries (see CommonConfig.name), and at any instant exactly one of them is in effect - the config write path enforces that - so "the configuration of this store right now" is a single entry, and everything the store does with routes, flags and limits reads it from here rather than being handed a snapshot that goes stale.

export class StoreConfig {
    constructor(
        public readonly name: string,
        entries: HostedConfig[],
    ) {
        this.update(entries);
    }

    // Every entry naming this store, oldest window first - past ones included, because a stamped write or a scan can legitimately concern a window that has already ended
    private entries: HostedConfig[] = [];

    /** The routing config changed. Same store either way: its name did not change, so neither did its folder, its index, or the data in it. */
    /** No entries is a real state, not an error: a store exists as soon as its folder does, and it may never have heard of a configuration (see StorePolicy). */
    public update(entries: HostedConfig[]): void {
        // Never go from configured back to UNCONFIGURED: keep the last configuration that worked. There is no point in emptying it - if this store was genuinely removed from the config, nobody will request it again, and the stale entries are not worth cleaning up (they are tiny, named stores are rarely removed, and a service restart clears them eventually). Keeping them is REQUIRED for the out-of-sync cases: a bad config that stops naming us would otherwise leave the store rejecting every write, including the ones that would let the configuration converge - it just won't update until a restart, and a restart can't complete against an out-of-date configuration, which is an infinite loop.
        if (!entries.length && this.entries.length) {
            console.warn(`Ignoring a routing config update that would leave store ${JSON.stringify(this.name)} with NO entries: keeping its current ${this.entries.length} entr${this.entries.length === 1 && "y" || "ies"} ${JSON.stringify(this.entries.map(x => ({ validWindow: x.validWindow, route: x.route })))}`);
            return;
        }
        let ordered = [...entries];
        sort(ordered, x => x.validWindow[0]);
        this.entries = ordered;
    }

    public all(): HostedConfig[] {
        return this.entries;
    }

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
    public current(): StorePolicy {
        let now = Date.now();
        let containing = this.entries.find(x => x.validWindow[0] <= now && now < x.validWindow[1]);
        if (containing) return containing;
        let upcoming = this.entries.find(x => x.validWindow[0] > now);
        if (upcoming) return upcoming;
        let last = this.entries[this.entries.length - 1];
        if (last) return last;
        return UNCONFIGURED;
    }
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

// A store nobody has configured: always valid, the whole key space, no delays and no limits. Every one of these is the answer that does the least - it holds its own data and nothing else happens to it - which is what makes a store usable before it has ever seen a config.
const UNCONFIGURED: StorePolicy = { validWindow: FULL_VALID_WINDOW };
