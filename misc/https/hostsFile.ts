import fs from "fs";
import os from "os";

// Cross-platform hosts-file editing, WITHOUT any third-party dependency. The approach (per-platform path, platform line endings, space-separated "<ip> <hostname>" entries, update-matching-hostname-else-append) is the same one the widely-used `hostile` npm package uses - but that package pulls in several dependencies (once, split, @ljharb/through), so this reimplements the ~40 lines we actually need instead of importing them. Used with --selfSigned, where we resolve the ip-domain locally via the hosts file instead of a public (Cloudflare) DNS record. NOTE: a hosts entry only affects THIS machine, so a self-signed server reachable from other machines still needs those machines to resolve its domain (a real DNS record, or the same hosts entry).

const WINDOWS = os.platform() === "win32";
// The canonical hosts-file locations (same as hostile)
const HOSTS_PATH = WINDOWS ? "C:/Windows/System32/drivers/etc/hosts" : "/etc/hosts";
const EOL = WINDOWS ? "\r\n" : "\n";
// Tags the lines we manage, so they are recognizable (and safe to rewrite/remove) without touching the user's own entries
const MARKER = "# managed by sliftutils hostsFile";

// The hostname of a line, or undefined for a blank/comment/malformed line. The marker is a comment, so it is stripped here too - matching works the same for our lines and the user's.
function lineHostname(line: string): string | undefined {
    let noComment = line.replace(/#.*/, "").trim();
    if (!noComment) return undefined;
    let parts = noComment.split(/\s+/);
    if (parts.length < 2) return undefined;
    return parts[1];
}

/** Ensures the hosts file maps `hostname` to `ip` (adding our tagged line, or updating it/an existing line for the same hostname). Idempotent. Returns false, with a warning telling the user the line to add by hand, if the file can't be written (writing the hosts file needs admin/root). */
export function setHostsEntry(config: { ip: string; hostname: string }): boolean {
    let { ip, hostname } = config;
    let desired = `${ip} ${hostname} ${MARKER}`;
    let lines: string[];
    try {
        lines = fs.readFileSync(HOSTS_PATH, "utf8").split(/\r?\n/);
    } catch (e) {
        console.error(`Could not read the hosts file ${HOSTS_PATH} to map ${hostname} -> ${ip}: ${(e as Error).stack ?? e}. Add this line yourself: ${ip} ${hostname}`);
        return false;
    }
    // A trailing newline leaves a final "" - drop trailing blanks so we don't accumulate them, and re-add exactly one newline at the end when we write
    while (lines.length && lines[lines.length - 1] === "") lines.pop();

    let index = lines.findIndex(line => lineHostname(line) === hostname);
    if (index >= 0) {
        if (lines[index] === desired) return true;
        lines[index] = desired;
    } else {
        lines.push(desired);
    }
    try {
        fs.writeFileSync(HOSTS_PATH, lines.join(EOL) + EOL);
    } catch (e) {
        console.error(`Could not write the hosts file ${HOSTS_PATH} to map ${hostname} -> ${ip} (writing it needs admin/root): ${(e as Error).stack ?? e}. Add this line yourself: ${ip} ${hostname}`);
        return false;
    }
    return true;
}

/** Removes our managed entry for `hostname` (only lines we added, tagged with the marker). No-op if absent or the file can't be written. */
export function removeHostsEntry(hostname: string): void {
    let lines: string[];
    try {
        lines = fs.readFileSync(HOSTS_PATH, "utf8").split(/\r?\n/);
    } catch {
        return;
    }
    let kept = lines.filter(line => !(line.includes(MARKER) && lineHostname(line) === hostname));
    if (kept.length === lines.length) return;
    while (kept.length && kept[kept.length - 1] === "") kept.pop();
    try {
        fs.writeFileSync(HOSTS_PATH, kept.join(EOL) + EOL);
    } catch { }
}
