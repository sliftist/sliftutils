import fs from "fs/promises";
import path from "path";
import { UNREVOKE_DELAY } from "../authorizedKeys/daemon/paths";
import { keysDir } from "../authorizedKeys/sources";
import { messageTimestamp } from "../notifications/discord";

// When this machine first saw each unrevoke, by unrevoke id.
//
// The same rule the ssh keys get, for the same reason: an unrevoke waits an hour before it counts,
// so a signing key that was itself stolen cannot instantly undo the revocation that shut it out.
// Counted from when we first saw it, never from a time the file states - whoever wrote the file
// chooses that, and would choose an hour ago.
//
// On disk, because a check runs in whatever process happens to be asking. Measuring from process
// start would restart the hour on every request and the unrevoke would never arrive. Kept beside
// the repo keys rather than in the daemon's state, because this has to work on a machine with no
// daemon, which is most of them.
const FIRST_SEEN_FILE = "machine-unrevokes.json";

function firstSeenPath() {
    return path.join(keysDir(), FIRST_SEEN_FILE);
}

async function readFirstSeen(): Promise<{ [unrevokeId: string]: number }> {
    try {
        return JSON.parse(await fs.readFile(firstSeenPath(), "utf8"));
    } catch (e) {
        // Never written, or unreadable. Either way nothing has been seen before now.
        return {};
    }
}

/** Whether an unrevoke has waited out its hour, recording the first sighting if this is one.

    Returns false the first time, which is the point: seeing an unrevoke is not the same as
    honouring it. */
export async function unrevokeInEffect(unrevokeId: string) {
    let firstSeen = await readFirstSeen();
    let seenAt = firstSeen[unrevokeId];
    if (!seenAt) {
        seenAt = Date.now();
        firstSeen[unrevokeId] = seenAt;
        await fs.mkdir(path.dirname(firstSeenPath()), { recursive: true, mode: 0o700 });
        await fs.writeFile(firstSeenPath(), JSON.stringify(firstSeen, undefined, 4) + "\n");
    }
    if (Date.now() - seenAt < UNREVOKE_DELAY) {
        console.log(
            `Holding the unrevoke ${unrevokeId} until ${messageTimestamp(new Date(seenAt + UNREVOKE_DELAY))}`
        );
        return false;
    }
    return true;
}
