export declare const MACHINES_DIR = "machines";
/** One machine we are willing to talk to, and the addresses it may talk to us from. */
export type MachineState = {
    machineId: string;
    ips: string[];
    addedAt: string;
};
/** This machine's keys repo, worked out once and then remembered.

    A failure is remembered too, but only briefly: a server may well start before the machine has
    been set up, and should start working when it is, rather than needing a restart. */
export declare const keysRepo: {
    (): Promise<{
        repoPath: string;
        sourceURL: string;
    }>;
    reset(): void;
    set(newValue: Promise<{
        repoPath: string;
        sourceURL: string;
    }>): void;
};
/** Every machine a checkout lists. Without a repo, this machine's own. */
export declare function getMachines(repoPath?: string): Promise<MachineState[]>;
/** The machines this system trusts, as the signed repo lists them.

    Held rather than read per call, and refreshed in the background, so nobody asking whether a
    machine is trusted waits for a directory of files to be read and a signature to be checked. A
    refresh that fails leaves the list we already have: the checkout is only stale, not wrong. */
export declare function getTrustedMachines(): Promise<MachineState[]>;
/** The machine id of a machine reached over ssh, generating and installing an identity for it if
    it has none under this domain. The private key ends up on that machine and nowhere else. */
export declare function getOrCreateRemoteMachineId(host: string, domain: string): Promise<string>;
/** Makes a checkout list exactly these machines: those named are written with the addresses given,
    and anything not named is removed. So read them, change what you want, and write the result.

    The addresses are part of setting rather than a separate step, because a machine with no
    address it may talk from is not a machine that would ever be accepted - there is no state where
    naming one without them means anything.

    Nothing here signs or commits. The signature is what every other machine checks before
    believing any of this, and it takes the hardware key, so `yarn signfiles git` is still yours to
    run afterwards. */
export declare function setMachines(config: {
    repoPath?: string;
    machines: {
        machineId: string;
        ips: string[];
    }[];
}): Promise<MachineState[]>;
/** What to run to trust a machine that has just been refused.

    Everything in it is already known to whoever is being refused: their machine id, the address we
    saw them at, and the domain they just talked to. Handing it back saves them working out the
    parts of a command they have every right to know. Running it still takes the hardware key on
    the machine that owns the repo, so telling them costs nothing. */
export declare function addMachineCommand(config: {
    machineId: string;
    ip: string;
    domain?: string;
}): string;
/** Whether we will talk to this machine, coming from this address.

    Both halves are required and neither is a guess: the caller knows the machine id because the
    connection proved it, and knows the address because the packets came from there. A machine we
    do not list is simply not accepted. A machine we do list, arriving from an address it does not
    have, is treated as the same kind of event as a stolen ssh key - it is revoked everywhere, and
    stays revoked until an unrevoke allows that machine from that address.

    Says why when the answer is no, because the three ways to be refused are entirely different
    things to a person reading it: never trusted at all, trusted but frozen, or trusted and talking
    from somewhere it should not be.

    Throws when the repo itself cannot be read or is not signed, rather than answering false: that
    is a broken installation, not a rejected machine, and the two deserve different handling. */
export type MachineVerdict = {
    accepted: boolean;
    reason: string;
};
export declare function isMachineAccepted(config: {
    machineId: string;
    ip: string;
    domain?: string;
}): Promise<MachineVerdict>;
