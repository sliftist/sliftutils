# Remote storage — core design ideas

This is the reasoning behind the remote storage system (createArchives / storageServer / BlobStore). The code documents the mechanics; this documents the ideas that must survive refactors.

## Scanning + tombstones + versions make any two sources mergeable

Every store fully rescans its sources' metadata (on startup and periodically), and every write — including deletions — is ordered by last-write time. Deletions are tombstones: an empty file IS a missing file, kept as a size-0 index entry (for a week) so the deletion itself propagates and reconciles like any other write. Because everything is a timestamped write and scans are bidirectional (pull what they have, push what they're missing), any two sources can be merged in any order and converge to the same state: newest write time wins, per file. There is no operation whose loss corrupts the system — a failed background write, a missed delete, a source that was down for a day — the next scan reconciles it.

## Deletions are marked, not performed — the bytes become history

A deletion never removes bytes from a server's disk: the index MARKS the key deleted (keeping its entry - size, holder, original write time), reads and listings stop finding it, and the deletion propagates as before. The bytes sit on disk as deletion history, per node, until the history outgrows max(10GB, live bytes × history factor — see getHistoryFactor) — then the OLDEST deletions lose their bytes and demote to plain tombstones, which age out on the week timer as before (a marked deletion never expires by time, only by size: purging its tombstone while its bytes remain would let the next disk scan resurrect them). While the history holds a file, includeMarked reads and listings can still see it, and undelete (a set carrying SetConfig.undelete) flips the index entry back to live with a fresh write time — the bytes never moved, so reads just work again, and the restore propagates to peers the way the deletion did. Raw sources with no index (backblaze) keep the old behavior: deletions materialize as empty files there, so history lives on server disks only.

## storage/storagerouting.json Has the routing config and is duplicated on every node. 

Each bucket stores its complete routing config (the full redundancy list) inside itself, at storage/storagerouting.json, on every source. Discovery is therefore trivial: as long as ONE node is up, a client reading it gets the full overview of the intended sources. And because clients re-discover on every startup (and re-read every 5 minutes), a developer can change the configuration in one place and clients rapidly accept it — no redeploy, no coordinated restart of the fleet.

If the client tries to do a write where the valid state is far enough away or the sharding is wrong, it will re-download the routing config throttled, so it only does this at most once every 30 seconds, and retry the request.

Storage routing JSON is only written to if we have write access and it's only written to on startup, it doesn't propagate. that way things don't revert without the developer intentionally rerunning it. 

## A source's name is the storage; everything else about it is policy

Every source entry carries a name, and that name is the storage it refers to: one folder on the server that holds it, one store, one index. Entries sharing a name (for the same account and bucket) ARE the same storage, however many there are and whatever their windows and routes say — and a request resolves to a store by that name alone, comparing nothing else. Windows and routes are policy layered on top: they decide WHEN a source is written to and WHICH KEYS it takes, and changing them never moves a byte, because they were never what said where the bytes live.

This is why re-routing is safe and free. Previously the folder was derived from the route, so re-sharding renamed the storage under a running server and stranded whatever was in the old folder. Now the route can change as often as you like and the data does not move; if you want data in a different place, you say so by using a different name, which is a decision the developer makes deliberately. The flip side is that names must be treated as permanent identifiers: two unrelated entries sharing a name merge their data, and reusing a retired name hands the new entry the retired one's files. The server does exactly what the name says and does not try to guess.

## Redundancy, sharding, and deployment

For redundancy, we can just have multiple different configurations that will satisfy the same request. The first one is the one that we write to. If that one's down, we don't do writes.

However, there's also sharding, where we have different route ranges that values can hash to. Values can explicitly try to write to a specific value via a special like hash override key. This allows us to sometimes make our rights hit a server which has less latency. In the case that the client writer will accept the fact that we might change the key.

The valid windows allow us to schedule deployments, so the nodes can switch over gracefully.

## The index is a Map + a transaction log, and our own disk is just another source

Each bucket's store keeps an index of every file (path, write time, size, holding source) as a plain in-memory Map, with an append-only transaction log behind it (TransactionFile) — one file, one record per set, delete or purge. Deletions live in a second map beside it, holding the time each key was deleted, so a tombstone is not a file with a size of zero that every listing, scan and count has to remember to skip: it is simply not among the files. That also makes expiring them a walk of the tombstones alone. The index takes the time of every change and refuses anything older than what it has, so ordering is decided in one place rather than at each of the paths a write can arrive by — and a write older than the deletion that removed a key cannot bring it back. Existence checks and the file count are Map operations, listings and totals are one pass over memory, and nothing reads a source to answer them. The log is only ever there to rebuild the Map on startup: it is replayed once, and rewritten from the Map whenever it has grown past a few records per surviving value, so rewriting the same keys forever cannot make it grow forever. Appends are coalesced, so a crash can lose the last moment of index changes — which is acceptable precisely because of the section above: a scan reconstructs anything the index is missing. The trick that keeps the index accurate: our own disk is not special-cased, it is simply the first synchronization source. The same scan/reconcile code that synchronizes remote sources also synchronizes the disk with the index, so the index self-heals from the same machinery instead of needing separate consistency logic.

## Metadata first, data second

We have an index that says where our data is, which we load immediately. Therefore, we can start acting as the authority immediately. And then we do a fast sync based on all of our sources, one of them being a disk source, in order to update this. This means that almost all the time we are immediately ready, and if anything is out of sync, we'll find it as quickly as possible. The index and our syncs just synchronize which files exist, their write times, and their sizes, which is almost always sufficient to characterize a unique state, while being very fast, and supported for all sources (backblaze, etc).

Being the authority means the index IS the answer: a key that is not in it does not exist here, and a read that misses it does nothing special — it does not go poke the sources, and it does not wait. Scans are what fill the index, on their own schedule. Listings are the one exception, and they wait for our own disk's first scan before answering: a single key coming back missing is a miss the caller can retry, but a listing that quietly omits half a folder looks like an answer and gets acted on. The gap this leaves is a store that comes up with files in its folder that its persisted index doesn't know about (another process wrote them), which stay invisible to reads until the disk scan reaches them — and that is fine, because valid windows hand over with notice: a node becomes the write target at a scheduled time, not the moment it starts, so it has finished scanning long before anyone is asking it for those files.

## Client writes are consistent; client reads are redundant

Clients always write to the same node — the first source whose valid window is current — and if that node is down, the write FAILS rather than going to another node. A client having a network hiccup and wrongly deciding nodes are down must never scatter its writes across the chain; that would desynchronize the sources based on one client's flaky view of the network. Reads, by contrast, fail over freely across every redundant source: sources are synchronized copies, so reading from any of them is safe. Maximum read uptime, strictly consistent writes. (Write redundancy still exists — it just lives server-side: the receiving node fans writes out downstream and reconciliation heals anything missed, all ordered by the once-stamped write time.)

## Trust instead of API keys

Machines authenticate with their certs.ts identity (proving ownership of their machine key with a signed, server-bound token), and access is granted per account to specific machineIds. No API keys are minted, copied into configs, or passed around — granting a machine access is one command on the storage machine, and revoking it is removing the trust record. The only API keys left in the system are the ones third parties force on us: backblaze and cloudflare, both resolved through getSecret.

## storage/storagerouting.json is a special file

    This is our special file that stores the routing information. We write it directly to each node. The client side tries to keep an updated version of these (that's mentioned earlier And is how the client can keep up to date even if the client's code isn't up to date, As long as at least one of the sources is still alive).

    It is a file IN the store, and the store OWNS it: a store reads its own copy and configures itself from it - its routes, its windows, its flags, and which peers it synchronizes with. A store that has no copy is a complete, working store of just its own disk, valid always, for the whole key space, which is what lets a store exist before it has ever heard of a configuration.

    It propagates by PULL, not push: beside the scan loops, every peer is asked for this one file every five minutes - far more often than a full rescan, because it is small and because it is the file that decides what everything else does. A copy with a greater version is written into our own store as an internal write, exactly like a scan storing anything else it pulled, and the store notices that file landing and re-configures itself. So an operator writing a config and a peer's copy arriving are the same event, and there is one mechanism instead of two. Older or equal versions are ignored, which is what stops a config from ever reverting.

    It is exempt from every check a normal write passes - windows, routes, immutability, internal-write acceptance - because it is the file that DEFINES those things: judging it by the config it is about to replace is how a store gets stuck on a configuration it can never be told to leave. The write time still applies, latest wins.

## fast writes

    We support a flag that does fast writes, which will cause us to batch all the writes in memory, Returning from the set call immediately. This allows you to do many writes to the same file with very little disk I/O. This uses a configurable delay amount. You could set it to zero and then we just won't delay it at all, and we'll flush everything to the disk immediately away. 

    The delay is a wrapper around ONE source, not a buffer inside the store: a delayed source takes the write into memory, returns, collapses repeated writes to the same path, and serves its own pending writes to anything reading through it. So each source gets its own delay, passed in when it is built — our own disk and our own storage servers take a short one (cross-node redundancy should not wait minutes), an expensive external source like backblaze takes the full one. The store itself has no idea any of this is happening; it writes to its sources and updates its index, and the index records the write when it is accepted, not when it reaches storage.

    The deploy system will tell us if it's intending to switch over a source, which we use to create a virtual valid state window in the middle that uses a different port. That port is only ever a second way to reach a source we already have, so we never scan it (its listing would be the listing we already get from that source) and we never record it as the holder of anything — index entries name the source it was split out of, which outlives it. 

    We look at the valid state windows and we make sure we never delay past the valid state window. In fact, if we are within five minutes of being invalid due to the valid state window, we flush the writes immediately. That way, when the next valid window starts running, the writes will be already on disk. 

    We also do scans when we are coming up to the valid state window. If we are going to be the new valid state window, both before, a little bit after, and farther after. This helps the switch over be smoother so we get all of the trailing writes. These scans use our ability to ask for the changes since a certain time. We do the scan on the right write node. The write node is always the first node in order (with a valid state window and matching the route hash). Which might result in us having to scan multiple nodes if we require multiple nodes to fill the full route hash window. 

# Smooth transitions

    If the deploy system gives us enough notice about a change, or if the configuration is changed, but we have enough notice about the valid state changes (accepting the fact that the final window, which will usually trail to max safe number, will be instantaneously changed to stop earlier, but it should still be sometime earlier in the future. And so the transitionary point will still be of sufficient notice), THEN, all changes should go almost 100% smoothly with very little gap for any data loss. The only time which the data will be slightly incorrect is it might be possible that someone writes at the very end of a valid state window, and then they immediately try to read it, but then they read it from a different source because the valid state window has just ended. In that case, they may not read the write-back immediately. However, within a minute they should be able to read the write back because of the extra scans that we do on transitionary points. 

    We also shouldn't be doing any instantaneous internal destruction or closing of ports as long as we're given sufficient notice. 