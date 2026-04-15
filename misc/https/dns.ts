import { httpsRequest } from "socket-function/src/https";
import { cache, lazy } from "socket-function/src/caching";
import fs from "fs";
import { delay } from "socket-function/src/batching";
import { SocketFunction } from "socket-function/SocketFunction";

const DNS_TTLSeconds = {
    "TXT": 60,
    "A": 60,
};

const getZoneId = cache(async (rootDomain: string): Promise<string> => {
    let zones = await cloudflareGETCall<{ id: string; name: string }[]>("/zones", {});
    let selected = zones.find(x => x.name === rootDomain);
    if (!selected) {
        throw new Error(`Could not find zone for ${rootDomain}. Found ${zones.map(x => x.name).join(", ")}`);
    }
    return selected.id;
});

function getRootDomain(key: string) {
    if (key.endsWith(".")) {
        key = key.slice(0, -1);
    }
    return key.split(".").slice(-2).join(".");
}

export async function getRecordsRaw(type: string, key: string) {
    if (key.endsWith(".")) key = key.slice(0, -1);
    let zoneId = await getZoneId(getRootDomain(key));
    let results = await cloudflareGETCall<{
        id: string;
        type: string;
        name: string;
        content: string;
        proxied: boolean;
    }[]>(`/zones/${zoneId}/dns_records`);
    return results.filter(x => x.type === type && x.name === key);
}
export async function getRecords(type: string, key: string) {
    if (key.endsWith(".")) key = key.slice(0, -1);
    let raw = await getRecordsRaw(type, key);
    return raw.map(x => x.content);
}
export async function deleteRecord(type: string, key: string, value: string) {
    if (key.endsWith(".")) key = key.slice(0, -1);
    let zoneId = await getZoneId(getRootDomain(key));
    let prevValues = await getRecordsRaw(type, key);
    prevValues = prevValues.filter(x => x.content === value);
    if (prevValues.length === 0) {
        if (!SocketFunction.silent) {
            console.log(`No need to delete record, it was not found. ${JSON.stringify(value)} value was not in ${type} for ${key}, values ${JSON.stringify(prevValues.map(x => x.content))}`);
        }
        return;
    }

    console.log(`Removing records of ${type} for ${key}, values ${JSON.stringify(prevValues.map(x => x.content))}`);
    for (let value of prevValues) {
        await cloudflareCall(`/zones/${zoneId}/dns_records/${value.id}`, Buffer.from([]), "DELETE");
    }
}
/** Removes all existing records (unless the record is already present) */
export async function setRecord(type: string, key: string, value: string, proxied?: "proxied") {
    let stack = new Error();
    if (key.endsWith(".")) key = key.slice(0, -1);
    let zoneId = await getZoneId(getRootDomain(key));
    let prevValues = await getRecordsRaw(type, key);
    // NOTE: Apparently if we try to update by just changing proxied, cloudflare complains and
    //  says "an identical record already exists", even though it doesn't, we changed the proxied value...
    if (prevValues.some(x => x.content === value)) return;

    console.log(`Removing previous records of ${type} for ${key} ${JSON.stringify(prevValues.map(x => x.content))}`);
    let didDeletions = false;
    for (let value of prevValues) {
        didDeletions = true;
        await cloudflareCall(`/zones/${zoneId}/dns_records/${value.id}`, Buffer.from([]), "DELETE");
    }

    console.log(`Setting ${type} record for ${key} to ${value} (previously had ${JSON.stringify(prevValues.map(x => x.content))})`);
    const ttl = DNS_TTLSeconds[type as "A"] || 60;
    await cloudflarePOSTCall(`/zones/${zoneId}/dns_records`, {
        type: type,
        name: key,
        content: value,
        ttl,
        proxied: proxied === "proxied",
    });
    // NOTE: Apparently... even if the record didn't exist, we still have to wait...
    console.log(`Waiting ${ttl} seconds for DNS to propagate...`);
    await delay(ttl * 1000);
    console.log(`Done waiting for DNS to update.`);

}
/** Keeps existing records */
export async function addRecord(type: string, key: string, value: string, proxied?: "proxied") {
    if (key.endsWith(".")) key = key.slice(0, -1);
    let zoneId = await getZoneId(getRootDomain(key));
    let prevValues = await getRecordsRaw(type, key);
    // NOTE: Apparently if we try to update by just changing proxied, cloudflare complains and
    //  says "an identical record already exists", even though it doesn't, we changed the proxied value...
    if (prevValues.some(x => x.content === value)) return;
    console.log(`Adding ${type} record for ${key} to ${value} (previously had ${JSON.stringify(prevValues.map(x => x.content))})`);
    const ttl = DNS_TTLSeconds[type as "A"] || 60;
    await cloudflarePOSTCall(`/zones/${zoneId}/dns_records`, {
        type: type,
        name: key,
        content: value,
        ttl,
        proxied: proxied === "proxied",
    });
    console.log(`Waiting ${ttl} seconds for DNS to propagate...`);
    await delay(ttl * 1000);
    console.log(`Done waiting for DNS to update.`);
}


const getCloudflareCreds = lazy(async (): Promise<{ key: string; }> => {
    const path = "cloudflare.json";
    if (!fs.existsSync(path)) {
        throw new Error(`Must add cloudflare.json file to root of project.`);
    }
    let creds = JSON.parse(fs.readFileSync(path, "utf8")) as { key: string; };
    return {
        key: creds.key,
    };
});

async function cloudflareGETCall<T>(path: string, params?: { [key: string]: string }): Promise<T> {
    let url = new URL(`https://api.cloudflare.com/client/v4` + path);
    for (let key in params) {
        url.searchParams.set(key, params[key]);
    }
    let creds = await getCloudflareCreds();
    let result = await httpsRequest(url.toString(), [], "GET", undefined, {
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${creds.key}`,
        }
    });
    let result2 = JSON.parse(result.toString()) as { result: unknown; success: boolean; errors: { code: number; message: string }[] };
    if (!result2.success) {
        throw new Error(`Cloudflare call failed: ${result2.errors.map(x => x.message).join(", ")}`);
    }
    return result2.result as T;
}
async function cloudflarePOSTCall<T>(path: string, params: { [key: string]: unknown }): Promise<T> {
    return await cloudflareCall(path, Buffer.from(JSON.stringify(params)), "POST");
}
async function cloudflareCall<T>(path: string, payload: Buffer, method: string): Promise<T> {
    let url = new URL(`https://api.cloudflare.com/client/v4` + path);
    let creds = await getCloudflareCreds();
    let result = await httpsRequest(url.toString(), payload, method, undefined, {
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${creds.key}`,
        }
    });
    let result2 = JSON.parse(result.toString()) as { result: unknown; success: boolean; errors: { code: number; message: string }[] };
    if (!result2.success) {
        throw new Error(`Cloudflare call failed: ${result2.errors.map(x => x.message).join(", ")}`);
    }
    return result2.result as T;
}