// Locations the daemon owns. Fixed rather than configurable, so every machine looks the same and
// the config file only carries what genuinely differs between them.

export const CONFIG_PATH = "/etc/portsecure/daemon.json";
export const STATE_PATH = "/var/lib/portsecure/state.json";
export const KEYS_HISTORY_PATH = "/var/lib/portsecure/authorized-keys-history";
export const ROOT_AUTHORIZED_KEYS = "/root/.ssh/authorized_keys";
export const SSHD_CONFIG_PATH = "/etc/ssh/sshd_config";
export const SSHD_DROPIN_DIR = "/etc/ssh/sshd_config.d";
export const SSHD_DROPIN_PATH = "/etc/ssh/sshd_config.d/00-portsecure.conf";
export const PASSWD_PATH = "/etc/passwd";
export const AUTH_LOG_PATH = "/var/log/auth.log";

export const CHECK_INTERVAL = 60 * 1000;
export const WEBHOOK_CHECK_INTERVAL = 5 * 60 * 1000;
export const GIT_TIMEOUT = 120 * 1000;
export const MAX_ERROR_BODY_LENGTH = 500;
// A source that starts being signed by someone new is held at arm's length for this long, so a
// stolen signing key cannot push keys onto a machine before anyone notices the warning.
export const SIGNER_CHANGE_DELAY = 24 * 60 * 60 * 1000;
// An unrevoke waits this long before taking effect, so a compromised signing key cannot instantly
// undo the revocation that locked it out.
export const UNREVOKE_DELAY = 60 * 60 * 1000;
// After this many consecutive failures a repo is thrown away and cloned from scratch, which
// recovers from corruption and interrupted fetches. Counted in checks, so about a quarter hour.
export const MAX_REPO_FAILURES_BEFORE_RECLONE = 15;
