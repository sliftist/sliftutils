type DeployTakeover = {
    releaseTime: number;
    overlapTime: number;
    altPort?: number;
    intermediateStart?: number;
};
/** Called when the main port is already in use, which on a healthy machine only happens while our predecessor is still running a deploy overlap. Confirms that against the deploy timeline; if no deploy is in progress we are in a bad state (someone else holds our port) and the process must not keep running. */
export declare function detectDeployTakeover(): Promise<DeployTakeover>;
export declare function setAltPort(port: number): void;
/** The window in which writes belong to our alternate port: from partway through the overlap (giving the predecessor notice to flush) until safely past its kill (giving us time to actually take the main port). */
export declare function getTakeoverIntermediate(): {
    start: number;
    end: number;
    altPort: number;
} | undefined;
/** We never stop listening on the alternate port while its window is still valid, and hold it well past that for clients that have not caught up yet. */
export declare function getAltPortListenEnd(): number;
/** How long to wait between main-port acquisition attempts: tight around our predecessor's scheduled death (when the port actually frees), relaxed otherwise. */
export declare function getMainPortAcquireDelay(): number;
export {};
