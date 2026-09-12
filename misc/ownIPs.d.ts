/** Every address this machine can be reached at, or seen as.

    Both halves, because which one applies depends on who is doing the seeing: something on the
    same network sees one of our interface addresses, and anything past a NAT sees the address the
    NAT presents. A machine cannot work the second one out alone, which is why it is asked for.

    Loopback and the other internal interfaces are left out - nothing outside this machine ever
    sees us as those - and so is ipv6, because everything consuming this deals in ipv4.

    A set, because a machine that is not behind a NAT sees its own address in both halves. */
export declare function getOwnIPs(): Promise<string[]>;
