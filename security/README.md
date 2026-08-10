# security

Tools for locking down machines. One folder per kind of security concern.

## notifications

Discord notifications, so a machine can raise the alarm somewhere a person will see it.

The webhook lives on the machine that sends, in `/etc/portsecure/discord-webhook`, and nothing
starts without one. `configureDiscordNotifications` loads it and aborts the process if it is
missing, then watches the file and warns the old webhook if it is ever swapped.

    yarn setupnotify <host> <discord-webhook-url> [replace]

`replace` is required to overwrite a host's existing webhook with a different one.

## authorizedKeys

Keeps root's `authorized_keys` equal to the merged contents of one or more git repos, and turns
off every other way in.

    yarn securessh <host> add <repo-private-key> [repo-url]
    yarn securessh <host> remove [repo-url]
    yarn securessh <host> list
    yarn securessh <host> update

With no repo url, the repo you are standing in is used, as long as it holds keys and has an
origin to clone from.

The daemon runs on the host, so `update` is how a host picks up a newer build of it. It changes
nothing about which keys that host trusts.

Each source repo keeps its own deploy key. Both verbs refuse to run if the key you log in with
would not survive the change, since that would lock you out of the host permanently.

`daemon/portsecureDaemon.js` is what actually runs on the host, under systemd. It is plain
JavaScript on the Node built-ins alone so a target machine needs nothing installed. It:

- rewrites root's `authorized_keys` from the merged sources, archiving whatever it replaces
- reverts and reports edits made outside it, every 60 seconds
- reports changes to any other account's `authorized_keys`, without touching them
- polls every source every 5 minutes, and reports a repo whose history was rewritten
- disables password authentication, after checking `sshd` accepts the config

With no sources, or none readable, it leaves `authorized_keys` exactly as it is rather than
locking everyone out.

The daemon carries hand ports of several TypeScript files here, because it cannot import them.
Both copies are marked `PORTED CODE` and have to be changed together.

## signedFiles

Signs everything in a repo, so a machine pulling it can tell who published what it is about to
trust. Run it inside the repo you want signed.

    yarn signfiles [signing-key] [git]

`signedfiles.json` lists every non-ignored file with its size and sha256, and
`signedfiles.json.sig` is an ssh signature over it. With no key given, a hardware backed
`ed25519-sk` key at `~/.ssh/signfiles_ed25519_sk` is used, and created if missing - a key on disk
is compromised the moment the machine is, so the hardware key is the point. `git` also commits
and pushes, after signing, so a failed push never costs a second touch of the key.

### How authorizedKeys uses it

The daemon records the signer it last accepted for each source, and the keys it accepted from
them, on disk. Those recorded values are the reference, not the repo, because the repo is what an
attacker would be rewriting.

When a source starts being signed by a different key, the daemon warns on Discord and keeps
applying the keys it last accepted. It applies the new ones only after 24 hours of that same new
signer. Any different signer restarts the wait, so publishing twice in a row gains nothing, and a
return to the accepted signer cancels it. Losing a signature entirely counts as a change too, so
stripping it does not get anything through faster. Going the other way, from unsigned to signed,
is only ever an improvement and applies right away.

Every one of those messages names the public key, in the same `type base64` form `signfiles`
prints, or `<no public key>` when there is none.

A signature that does not verify, or a manifest that does not match the files on disk, is never
treated as an identity - that content is ignored and the last accepted keys stay. Which of the
two it is gets reported:

- the signature is byte for byte the one we already accepted, so the repo changed and nobody
  re-signed it. The changes are ignored until someone runs `signfiles` again.
- the signature did change and does not hold up, so it is corrupt.

Either way it is reported once, not every time it is polled.

## helpers

Shared plumbing: running commands over ssh, spawning child processes, and expanding `~`.
