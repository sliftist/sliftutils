export declare function setHostLabel(value: string): void;
/** A headline and the rest.

    The headline is all a phone shows. It gets the whole preview to itself: no product name, no
    host, no timestamp in front of it, because a person glancing at their lock screen needs to read
    what happened, not which machine said it or when. Those go at the end, where they are there for
    whoever opens the message and out of the way of whoever does not. */
export declare function notify(headline: string, body: string): Promise<void>;
