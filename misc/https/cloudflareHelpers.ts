import { lazy } from "socket-function/src/caching";
import { httpsRequest } from "socket-function/src/https";
import { getSecret } from "../getSecret";

export type CloudflareCreds = {
    key: string;
    /** Set for legacy global API keys, which auth via X-Auth-Email/X-Auth-Key. Absent for API tokens, which auth via Authorization: Bearer. */
    email?: string;
};

export const getCloudflareCreds = lazy(async (): Promise<CloudflareCreds> => {
    // Legacy global-key auth needs an email alongside the key, so prefer it when both secrets exist.
    try {
        let key = await getSecret("cloudflare.json.key");
        let email = await getSecret("cloudflare.json.email");
        return { key, email };
    } catch { }

    // API token form. Deliberately NOT caught: if this fails too, getSecret's error (which names every place it looked) is the one the caller should see.
    return { key: await getSecret("cloudflare.json.key") };
});

function getAuthHeaders(creds: CloudflareCreds): { [header: string]: string } {
    if (creds.email) {
        return {
            "X-Auth-Email": creds.email,
            "X-Auth-User-Service-Key": creds.key,
            "X-Auth-Key": creds.key,
        };
    }
    return { "Authorization": `Bearer ${creds.key}` };
}

export async function cloudflareGETCall<T>(path: string, params?: { [key: string]: string }): Promise<T> {
    let url = new URL(`https://api.cloudflare.com/client/v4` + path);
    for (let [key, value] of Object.entries(params || {})) {
        url.searchParams.set(key, value);
    }
    let creds = await getCloudflareCreds();
    let result = await httpsRequest(url.toString(), [], "GET", undefined, {
        headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(creds),
        }
    });
    let result2 = JSON.parse(result.toString()) as { result: unknown; success: boolean; errors: { code: number; message: string }[] };
    if (!result2.success) {
        throw new Error(`Cloudflare call failed: ${result2.errors.map(x => x.message).join(", ")}`);
    }
    return result2.result as T;
}
export async function cloudflarePOSTCall<T>(path: string, params: { [key: string]: unknown }): Promise<T> {
    return await cloudflareCall(path, Buffer.from(JSON.stringify(params)), "POST");
}
export async function cloudflareCall<T>(path: string, payload: Buffer, method: string): Promise<T> {
    let url = new URL(`https://api.cloudflare.com/client/v4` + path);
    let creds = await getCloudflareCreds();
    let result = await httpsRequest(url.toString(), payload, method, undefined, {
        headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(creds),
        }
    });
    let result2 = JSON.parse(result.toString()) as { result: unknown; success: boolean; errors: { code: number; message: string }[] };
    if (!result2.success) {
        throw new Error(`Cloudflare call failed: ${result2.errors.map(x => x.message).join(", ")}`);
    }
    return result2.result as T;
}
