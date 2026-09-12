/** A reason important enough to name the whole message. Its headline replaces the one the change
    itself would have got, because "somebody is using a key they should not" outranks "the keys
    changed" in the one line a phone shows. */
export type LeadingReason = {
    headline: string;
    body: string;
};
export declare function addChangeReason(reason: string): void;
/** For the one thing worth reading before anything else: somebody using a key from an address it
    is not allowed from. */
export declare function addLeadingChangeReason(reason: LeadingReason): void;
/** The reasons gathered since the last write, and clears them. Called whether or not anything
    changed, so reasons that came to nothing cannot show up against some later change. */
export declare function takeChangeReasons(): {
    leading: LeadingReason[];
    reasons: string[];
};
