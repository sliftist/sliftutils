export type HostServerConfig = {
    /** Full domain to host on (e.g. "testsite.example.com"). The HTTPS cert is created for this domain and *.domain, so using a subdomain never touches the root domain (beyond its _acme-challenge TXT record). */
    domain: string;
    port: number;
    /** Creates an unproxied A record pointing domain at this machine (publicIp, or our detected external IP) */
    setDNSRecord?: boolean;
    publicIp?: string;
    allowHostnames?: string[];
    /** When the port is busy (e.g. the previous deploy still holds it), mount on an alternate port instead (the socket server's built-in free-port scan), and keep trying to take the real port - once it frees, a raw TCP relay on the real port forwards to our listener (SocketFunction can only mount once per process). */
    portFallback?: {
        /** Delay until the next main-port acquisition attempt (tightened around the predecessor's scheduled death) */
        getAcquireDelay: () => number;
        /** Reports every port we become reachable on (the alternate at mount, the main port once relayed) */
        onListening: (port: number, isMainPort: boolean) => void;
    };
};
/** Hosts a SocketFunction server on a real domain, with an automatically created and renewed Let's Encrypt HTTPS certificate (cached in the home folder, shared between processes on the machine). Expose your controllers (and any RequireController setup) before calling this. Returns the mounted nodeId. */
export declare function hostServer(config: HostServerConfig): Promise<string>;
/** Returns the cached HTTPS cert for the domain, creating/renewing it first if it is past this process's renewal threshold. Reads the disk cache on every call, so a renewal done by a parallel process is picked up instead of renewing again. */
export declare function getFreshHTTPSCert(domain: string): Promise<{
    key: string;
    cert: string;
}>;
