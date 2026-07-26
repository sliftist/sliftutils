import { RemoteConfig } from "../IArchives";
/** Called every time a store applies a routing config to itself (see BlobStore's onRoutingApplied): arms the scans the config's upcoming window boundaries need. Each scan is scheduled once - the key includes the boundary it is for - so re-arming on every config application is harmless. */
export declare function scheduleBoundaryWork(account: string, bucketName: string, routing: RemoteConfig): void;
/** An operator's config knows nothing about a switchover that is in flight right now, so writing it as-is would cancel one mid-handover. The in-flight windows are put back into it first. */
export declare function reinjectIntermediates(current: RemoteConfig | undefined, incoming: RemoteConfig): RemoteConfig;
/** Started by deployTakeover once we are actually a deploy successor listening on an alternate port. Until then there are no switchover windows to write or expire, so nothing polls. */
export declare const startIntermediateMaintenance: {
    (): void;
    reset(): void;
    set(newValue: void): void;
};
