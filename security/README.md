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

With no repo url, the repo you are standing in is used, as long as it holds keys and has an
origin to clone from.

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

## helpers

Shared plumbing: running commands over ssh, spawning child processes, and expanding `~`.
