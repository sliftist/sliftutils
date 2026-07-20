import { RemoteConfig } from "../IArchives";
export type TakeoverEvent = "remapChanged";
/** Starts the takeover machinery. Port fallback (alternate port + registry + acquisition polling)
 *  works regardless; without a deploy timeline folder the switchover-specific parts (the remap,
 *  the tighter acquisition pacing) simply stay inert. */
export declare function initDeployTakeover(config: {
    domain: string;
    mainPort: number;
    storageFolder: string;
}): Promise<void>;
/** Called when we had to listen on an alternate port (the main port was still held by our
 *  predecessor): registers it so the predecessor can route the middle overlap window to us. */
export declare function registerAltPort(port: number): Promise<void>;
export declare function onTakeoverEvent(listener: (event: TakeoverEvent) => void): void;
/** The interpretation overlay: splits every source pointing at our domain+main port so the middle
 *  of the deploy overlap points at the alternate port. Pure, in-memory only - the stored routing
 *  config is never modified, and this must never be applied to data that gets persisted. */
export declare function applyDeployRemap(routing: RemoteConfig): RemoteConfig;
/** A stamp of the current remap interpretation, advertised in ping responses - so every connected
 *  client learns of a takeover within one ping interval, instead of waiting for its config poll
 *  or a write rejection. */
export declare function getTakeoverStamp(): string | undefined;
/** The middle-window alternate port of an active remap. The OTHER process of the takeover lives on
 *  this port on OUR machine (same disk!), so sources pointing at it are self, never sync targets. */
export declare function getTakeoverAltPort(): number | undefined;
/** For the dying process of a takeover: our own process's data ends at the write handoff - fast
 *  writes must be on disk by then. Undefined for the successor and in normal operation. Both
 *  processes share the config identity (all self windows look like "ours" to both), so this is
 *  the only way the dying side knows the post-handoff windows belong to the other process. */
export declare function getOwnWindowEndClip(): number | undefined;
/** How long to wait between main-port acquisition attempts: tight around the predecessor's
 *  scheduled death (when the port actually frees), relaxed otherwise. */
export declare function getMainPortAcquireDelay(): number;
