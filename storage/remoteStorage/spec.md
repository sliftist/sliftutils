# Remote storage — core design ideas

This is the reasoning behind the remote storage system (createArchives / storageServer / BlobStore). The code documents the mechanics; this documents the ideas that must survive refactors.

## Scanning + tombstones + versions make any two sources mergeable

Every store fully rescans its sources' metadata (on startup and periodically), and every write — including deletions — is ordered by last-write time. Deletions are tombstones: an empty file IS a missing file, kept as a size-0 index entry (for a week) so the deletion itself propagates and reconciles like any other write. Because everything is a timestamped write and scans are bidirectional (pull what they have, push what they're missing), any two sources can be merged in any order and converge to the same state: newest write time wins, per file. There is no operation whose loss corrupts the system — a failed background write, a missed delete, a source that was down for a day — the next scan reconciles it.

## storage/storagerouting.json Has the routing config and is duplicated on every node. 

Each bucket stores its complete routing config (the full redundancy list) inside itself, at storage/storagerouting.json, on every source. Discovery is therefore trivial: as long as ONE node is up, a client reading it gets the full overview of the intended sources. And because clients re-discover on every startup (and re-read every 5 minutes), a developer can change the configuration in one place and clients rapidly accept it — no redeploy, no coordinated restart of the fleet.

If the client tries to do a write where the valid state is far enough away or the sharding is wrong, it will re-download the routing config throttled, so it only does this at most once every 30 seconds, and retry the request.

Storage routing JSON is only written to if we have write access and it's only written to on startup, it doesn't propagate. that way things don't revert without the developer intentionally rerunning it. 

## Redundancy, sharding, and deployment

For redundancy, we can just have multiple different configurations that will satisfy the same request. The first one is the one that we write to. If that one's down, we don't do writes.

However, there's also sharding, where we have different route ranges that values can hash to. Values can explicitly try to write to a specific value via a special like hash override key. This allows us to sometimes make our rights hit a server which has less latency. In the case that the client writer will accept the fact that we might change the key.

The valid windows allow us to schedule deployments, so the nodes can switch over gracefully.

## BulkDatabase2 index + our own disk as just another source

Each bucket's store keeps a BulkDatabase2 index of every file (path, write time, size, holding source), served from memory — existence checks and listings are extremely fast, never touching a source. The trick that keeps the index accurate: our own disk is not special-cased, it is simply the first synchronization source. The same scan/reconcile code that synchronizes remote sources also synchronizes the disk with the index, so the index self-heals from the same machinery instead of needing separate consistency logic.

## Metadata first, data second

We have an index that says where our data is, which we load immediately. Therefore, we can start acting as the authority immediately. And then we do a fast sync based on all of our sources, one of them being a disk source, in order to update this. This means that almost all the time we are immediately ready, and if anything is out of sync, we'll find it as quickly as possible. The index and our syncs just synchronize which files exist, their write times, and their sizes, which is almost always sufficient to characterize a unique state, while being very fast, and supported for all sources (backblaze, etc).

## Client writes are consistent; client reads are redundant

Clients always write to the same node — the first source whose valid window is current — and if that node is down, the write FAILS rather than going to another node. A client having a network hiccup and wrongly deciding nodes are down must never scatter its writes across the chain; that would desynchronize the sources based on one client's flaky view of the network. Reads, by contrast, fail over freely across every redundant source: sources are synchronized copies, so reading from any of them is safe. Maximum read uptime, strictly consistent writes. (Write redundancy still exists — it just lives server-side: the receiving node fans writes out downstream and reconciliation heals anything missed, all ordered by the once-stamped write time.)

## Trust instead of API keys

Machines authenticate with their certs.ts identity (proving ownership of their machine key with a signed, server-bound token), and access is granted per account to specific machineIds. No API keys are minted, copied into configs, or passed around — granting a machine access is one command on the storage machine, and revoking it is removing the trust record. The only API keys left in the system are the ones third parties force on us: backblaze and cloudflare, both resolved through getSecret.

## storage/storagerouting.json is a special file

    This is our special file that stores the routing information. We write it directly to each node. The client side tries to keep an updated version of these (that's mentioned earlier And is how the client can keep up to date even if the client's code isn't up to date, As long as at least one of the sources is still alive).

    IMPORTANTLY! This special file is never synchronized between different storage nodes. It's only directly written to, and it's only read off of our disk. It can be written to on any node. We don't take into account the valid state window or the shard. We still do take into account the write time, though, the latest write time wins. We only allow writes if version >= the previous version.

## fast writes

    We support a flag that does fast writes, which will cause us to batch all the writes in memory, Returning from the set call immediately. This allows you to do many writes to the same file with very little disk I/O. This uses a configurable delay amount. You could set it to zero and then we just won't delay it at all, and we'll flush everything to the disk immediately away. 

    The deploy system will tell us if it's intending to switch over a source, which we use to create a virtual valid state window in the middle that uses a different port. 

    We look at the valid state windows and we make sure we never delay past the valid state window. In fact, if we are within five minutes of being invalid due to the valid state window, we flush the writes immediately. That way, when the next valid window starts running, the writes will be already on disk. 

    We also do scans when we are coming up to the valid state window. If we are going to be the new valid state window, both before, a little bit after, and farther after. This helps the switch over be smoother so we get all of the trailing writes. These scans use our ability to ask for the changes since a certain time. We do the scan on the right write node. The write node is always the first node in order (with a valid state window and matching the route hash). Which might result in us having to scan multiple nodes if we require multiple nodes to fill the full route hash window. 

# Smooth transitions

    If the deploy system gives us enough notice about a change, or if the configuration is changed, but we have enough notice about the valid state changes (accepting the fact that the final window, which will usually trail to max safe number, will be instantaneously changed to stop earlier, but it should still be sometime earlier in the future. And so the transitionary point will still be of sufficient notice), THEN, all changes should go almost 100% smoothly with very little gap for any data loss. The only time which the data will be slightly incorrect is it might be possible that someone writes at the very end of a valid state window, and then they immediately try to read it, but then they read it from a different source because the valid state window has just ended. In that case, they may not read the write-back immediately. However, within a minute they should be able to read the write back because of the extra scans that we do on transitionary points. 

    We also shouldn't be doing any instantaneous internal destruction or closing of ports as long as we're given sufficient notice. 