/** Ensures the hosts file maps `hostname` to `ip` (adding our tagged line, or updating it/an existing line for the same hostname). Idempotent. Returns false, with a warning telling the user the line to add by hand, if the file can't be written (writing the hosts file needs admin/root). */
export declare function setHostsEntry(config: {
    ip: string;
    hostname: string;
}): boolean;
/** Removes our managed entry for `hostname` (only lines we added, tagged with the marker). No-op if absent or the file can't be written. */
export declare function removeHostsEntry(hostname: string): void;
