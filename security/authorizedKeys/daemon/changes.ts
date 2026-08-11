// Why root's authorized_keys is about to change, collected as it happens.
//
// Nothing announces itself at the moment it decides something. A revocation arriving, a key being
// revoked here, an unrevoke taking effect, a repo moving on: each of those says what it is and
// leaves it here. The file is then written, and only if it actually came out different does any of
// it get reported, in one message.
//
// Doing it the other way round is what produced several messages for one event, and messages about
// removing a key that had already gone.

/** A reason important enough to name the whole message. Its headline replaces the one the change
    itself would have got, because "somebody is using a key they should not" outranks "the keys
    changed" in the one line a phone shows. */
export type LeadingReason = { headline: string; body: string };

let reasons: string[] = [];
let leadingReasons: LeadingReason[] = [];

export function addChangeReason(reason: string) {
    // The same reason twice in one pass says nothing the once did not.
    if (!reasons.includes(reason)) {
        reasons.push(reason);
    }
}

/** For the one thing worth reading before anything else: somebody using a key from an address it
    is not allowed from. */
export function addLeadingChangeReason(reason: LeadingReason) {
    if (!leadingReasons.some(existing => existing.headline === reason.headline)) {
        leadingReasons.push(reason);
    }
}

/** The reasons gathered since the last write, and clears them. Called whether or not anything
    changed, so reasons that came to nothing cannot show up against some later change. */
export function takeChangeReasons() {
    let taken = { leading: leadingReasons, reasons };
    leadingReasons = [];
    reasons = [];
    return taken;
}
