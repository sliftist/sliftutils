# Remote storage — core design ideas

This is the reasoning behind the remote storage system (createArchives / storageServer / BlobStore). The code documents the mechanics; this documents the ideas that must survive refactors.

## Configuration updates happen only on startup

A client adopts a routing config once, during initialization, and then runs on it. Configs never automatically upgrade mid-run: the 5-minute poll picks up whatever the sources currently hold (so a developer's change spreads), but the version-gated *upgrade* — writing a newer configured version over an older stored one — happens only at startup. This is deliberate: config changes are made by a developer running code, and that developer is present at startup. It also prevents reversion loops — if a server briefly held a newer version and then went away, running clients don't cling to that phantom version; they follow what the surviving sources actually hold, and only a fresh startup with an explicitly newer configured version moves things forward again.

## Scanning + tombstones + versions make any two sources mergeable

Every store fully rescans its sources' metadata (on startup and periodically), and every write — including deletions — is ordered by last-write time. Deletions are tombstones: an empty file IS a missing file, kept as a size-0 index entry (for a week) so the deletion itself propagates and reconciles like any other write. Because everything is a timestamped write and scans are bidirectional (pull what they have, push what they're missing), any two sources can be merged in any order and converge to the same state: newest write time wins, per file. There is no operation whose loss corrupts the system — a failed background write, a missed delete, a source that was down for a day — the next scan reconciles it.

## The full source list is duplicated into every source

Each bucket stores its complete routing config (the full redundancy list) inside itself, at storage/storagerouting.json, on every source. Discovery is therefore trivial: as long as ONE node is up, a client reading it gets the full overview of the intended sources. And because clients re-discover on every startup (and re-read every 5 minutes), a developer can change the configuration in one place and clients rapidly accept it — no redeploy, no coordinated restart of the fleet.

## BulkDatabase2 index + our own disk as just another source

Each bucket's store keeps a BulkDatabase2 index of every file (path, write time, size, holding source), served from memory — existence checks and listings are extremely fast, never touching a source. The trick that keeps the index accurate: our own disk is not special-cased, it is simply the first synchronization source. The same scan/reconcile code that synchronizes remote sources also synchronizes the disk with the index, so the index self-heals from the same machinery instead of needing separate consistency logic.

## Trust instead of API keys

Machines authenticate with their certs.ts identity (proving ownership of their machine key with a signed, server-bound token), and access is granted per account to specific machineIds. No API keys are minted, copied into configs, or passed around — granting a machine access is one command on the storage machine, and revoking it is removing the trust record. The only API keys left in the system are the ones third parties force on us: backblaze and cloudflare, both resolved through getSecret.
