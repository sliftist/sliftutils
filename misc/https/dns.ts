import { cache, lazy } from "socket-function/src/caching";
import { delay } from "socket-function/src/batching";
import { SocketFunction } from "socket-function/SocketFunction";
import { isNode, timeInDay } from "socket-function/src/misc";
import { magenta } from "socket-function/src/formatting/logColors";
import { cloudflareCall, cloudflareGETCall, cloudflarePOSTCall, getCloudflareCreds } from "./cloudflareHelpers";

const DNS_TTLSeconds = {
    "TXT": 60,
    "A": 60,
};

const DNS_REFRESH_STALE_AFTER = timeInDay;

// We stamp our own "last asserted" time into the record's comment, because Cloudflare's
//  modified_on can only be moved by an actual content change - and re-asserting an already
//  correct record has no content change to make (a create errors with 81058, a no-op edit
//  doesn't bump the timestamp). Reading freshness from text we control sidesteps that entirely,
//  and lets us refresh a stale-but-correct record in place instead of deleting and recreating it.
const FRESHNESS_REGEX = /<set on:[^>]*>/;

/** Strips any prior freshness tag and appends a new one, preserving other comment text. */
function stampFreshness(comment?: string): string {
    let base = (comment ?? "").replace(FRESHNESS_REGEX, "").trim();
    let stamp = `<set on: ${new Date().toString()}>`;
    return base ? `${base} ${stamp}` : stamp;
}
/** Parses our tag back out; 0 (i.e. always stale) when it's absent or unparseable. */
export function freshnessTime(comment?: string): number {
    let match = FRESHNESS_REGEX.exec(comment ?? "");
    if (!match) return 0;
    return new Date(match[0].replace("<set on:", "").replace(">", "").trim()).getTime() || 0;
}

export const hasDNSWritePermissions = lazy(async () => {
    if (!isNode()) return false;
    try {
        await getCloudflareCreds();
        return true;
    } catch {
        return false;
    }
});

export const getZoneId = cache(async (rootDomain: string): Promise<string> => {
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
        modified_on: string;
        // Omitted by Cloudflare when the record has no comment.
        comment?: string;
    }[]>(`/zones/${zoneId}/dns_records`);
    // DNS names are case-insensitive and Cloudflare returns them lowercased, so a mixed-case key
    //  (e.g. a machine id subdomain) would never match an exact-case compare - match lowercased.
    let keyLower = key.toLowerCase();
    return results.filter(x => x.type === type && x.name.toLowerCase() === keyLower);
}

/** Cloudflare's batch endpoint applies deletes, then patches, then posts in a single database
 *   transaction. We route edits (patches) through here because the standalone PATCH/PUT verbs
 *   aren't usable in our setup, and because it lets "remove others + assert target" happen
 *   without a window where the name resolves to nothing. */
export async function batchRecords(zoneId: string, batch: {
    deletes?: { id: string }[];
    patches?: { id: string; comment?: string }[];
    posts?: { type: string; name: string; content: string; ttl: number; proxied: boolean; comment?: string }[];
}) {
    let payload: { [key: string]: unknown } = {};
    if (batch.deletes && batch.deletes.length > 0) payload.deletes = batch.deletes;
    if (batch.patches && batch.patches.length > 0) payload.patches = batch.patches;
    if (batch.posts && batch.posts.length > 0) payload.posts = batch.posts;
    try {
        await cloudflarePOSTCall(`/zones/${zoneId}/dns_records/batch`, payload);
    } catch (error) {
        console.error(`Error updating DNS records:`, { error: error, batch });
        throw new Error(`Error updating DNS records. ${JSON.stringify(batch)}. Error: ${error}`);
    }
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
/** Removes all existing records (unless the record is already present and fresh) */
export async function setRecord(type: string, key: string, value: string, proxied?: "proxied", staleAfter = DNS_REFRESH_STALE_AFTER) {
    if (key.endsWith(".")) key = key.slice(0, -1);
    let zoneId = await getZoneId(getRootDomain(key));
    let prevValues = await getRecordsRaw(type, key);
    let existing = prevValues.find(x => x.content === value);
    let others = prevValues.filter(x => x.content !== value);

    // Already correct and recently asserted - a prior run also cleaned up the other records,
    //  so there is nothing left to do.
    if (existing && Date.now() - freshnessTime(existing.comment) < staleAfter) return;

    // A single atomic batch: drop the wrong records, and either refresh the existing record's
    //  comment in place or create it - so the name is never left resolving to nothing.
    let ttl = DNS_TTLSeconds[type as "A"] || 60;
    let comment = stampFreshness(existing?.comment);
    console.log(magenta(`Setting ${type} record for ${key} to ${value} (previously had ${JSON.stringify(prevValues.map(x => x.content))})`));
    await batchRecords(zoneId, {
        deletes: others.map(x => ({ id: x.id })),
        patches: existing ? [{ id: existing.id, comment }] : [],
        posts: existing ? [] : [{ type, name: key, content: value, ttl, proxied: proxied === "proxied", comment }],
    });
    // Only a brand new record needs to propagate; an in-place comment refresh doesn't change the answer.
    if (!existing) {
        console.log(`Waiting ${ttl} seconds for DNS to propagate...`);
        for (let ttlLeft = ttl; ttlLeft > 0; ttlLeft--) {
            await delay(1000);
            console.log(`${ttlLeft} seconds left...`);
        }
        console.log(`Done waiting for DNS to update.`);
    }
}
/** Keeps existing records */
export async function addRecord(type: string, key: string, value: string, proxied?: "proxied", staleAfter = DNS_REFRESH_STALE_AFTER) {
    if (key.endsWith(".")) key = key.slice(0, -1);
    let zoneId = await getZoneId(getRootDomain(key));
    let prevValues = await getRecordsRaw(type, key);
    let existing = prevValues.find(x => x.content === value);
    if (existing && Date.now() - freshnessTime(existing.comment) < staleAfter) return;

    // Same single-batch flow as setRecord, minus the deletes (we keep sibling records here).
    let ttl = DNS_TTLSeconds[type as "A"] || 60;
    let comment = stampFreshness(existing?.comment);
    console.log(`Adding ${type} record for ${key} to ${value} (previously had ${JSON.stringify(prevValues.map(x => x.content))})`);
    await batchRecords(zoneId, {
        patches: existing ? [{ id: existing.id, comment }] : [],
        posts: existing ? [] : [{ type, name: key, content: value, ttl, proxied: proxied === "proxied", comment }],
    });
    if (existing) return;
    console.log(`Waiting ${ttl} seconds for DNS to propagate...`);
    for (let ttlLeft = ttl; ttlLeft > 0; ttlLeft--) {
        await delay(1000);
        console.log(`${ttlLeft} seconds left...`);
    }
    console.log(`Done waiting for DNS to update.`);
}
