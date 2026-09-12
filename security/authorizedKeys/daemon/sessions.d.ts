export type KeySession = {
    processId: number;
    user: string;
    ip: string;
    port: string;
};
export declare function parseAcceptedSessions(contents: string, fingerprint: string): KeySession[];
/** Ends every live session that authenticated with this key. Returns what was ended, so the
    revocation can say so rather than leaving it to be discovered. */
export declare function endSessionsUsingKey(fingerprint: string): Promise<KeySession[]>;
/** Disconnects every ssh session on the machine.

    Not only the ones using the key that was just taken away: a session that predates the key being
    removed is exactly as dangerous, and working out which sessions are still entitled to be here
    is guesswork. Anyone who still has access can reconnect in a second, and anyone who does not
    should not be here. */
export declare function endAllSSHSessions(): Promise<number[]>;
export declare function describeAllEnded(ended: number[]): string;
export declare function describeEndedSessions(ended: KeySession[]): string;
