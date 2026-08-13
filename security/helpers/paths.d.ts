/** Windows shells do not expand ~ themselves, and hunting down your home folder by hand is
    annoying, so we expand it on every platform. Both separators are accepted, because a Windows
    user may type either one. */
export declare function expandHome(filePath: string): string;
