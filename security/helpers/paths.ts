import os from "os";
import path from "path";

/** Windows shells do not expand ~ themselves, and hunting down your home folder by hand is
    annoying, so we expand it on every platform. Both separators are accepted, because a Windows
    user may type either one. */
export function expandHome(filePath: string) {
    if (filePath === "~") {
        return os.homedir();
    }
    if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
        return path.join(os.homedir(), filePath.slice(2));
    }
    if (filePath.startsWith("~")) {
        // ~otheruser needs an account database we cannot read portably, and quietly resolving it
        // to the wrong home would be worse than refusing.
        throw new Error(`Expected ~ or an ordinary path, was ${filePath}. Referring to another user's home with ~name is not supported.`);
    }
    return path.resolve(filePath);
}
