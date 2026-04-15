import { cache, lazy } from "socket-function/src/caching";
import fs from "fs";
import os from "os";
import { isNode, sort, timeInHour, timeInMinute } from "socket-function/src/misc";
import { delay } from "socket-function/src/batching";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";
import { blue, green, magenta } from "socket-function/src/formatting/logColors";
import debugbreak from "debugbreak";
import dns from "dns";
import { getSecret } from "../misc/getSecret";
import { httpsRequest } from "socket-function/src/https";

type BackblazeCreds = {
    applicationKeyId: string;
    applicationKey: string;
};

let backblazeCreds = lazy(async (): Promise<BackblazeCreds> => {
    let keyId = await getSecret("backblaze.json.applicationKeyId");
    let key = await getSecret("backblaze.json.applicationKey");
    return {
        applicationKeyId: keyId,
        applicationKey: key,
    };
});
const getAPI = lazy(async () => {
    let creds = await backblazeCreds();

    // NOTE: On errors, our retry code resets this lazy, so we DO get new authorize when needed.
    // TODO: Maybe we should get new authorization periodically at well?
    let authorizeRaw = await httpsRequest("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", undefined, "GET", undefined, {
        headers: {
            Authorization: "Basic " + Buffer.from(creds.applicationKeyId + ":" + creds.applicationKey).toString("base64"),
        }
    });

    let auth = JSON.parse(authorizeRaw.toString()) as {
        accountId: string;
        authorizationToken: string;
        apiUrl: string;
        downloadUrl: string;
        allowed: {
            bucketId: string;
            bucketName: string;
            capabilities: string[];
            namePrefix: string;
        }[];
    };

    function createB2Function<Arg, Result>(name: string, type: "POST" | "GET", noAccountId?: "noAccountId"): (arg: Arg) => Promise<Result> {
        return async (arg: Arg) => {
            if (!noAccountId) {
                arg = { accountId: auth.accountId, ...arg };
            }
            try {
                let url = auth.apiUrl + "/b2api/v2/" + name;
                let time = Date.now();
                let result = await httpsRequest(url, Buffer.from(JSON.stringify(arg)), type, undefined, {
                    headers: {
                        Authorization: auth.authorizationToken,
                    }
                });
                return JSON.parse(result.toString());
            } catch (e: any) {
                throw new Error(`Error in ${name}, arg ${JSON.stringify(arg).slice(0, 1000)}: ${e.stack}`);
            }
        };
    }

    const createBucket = createB2Function<{
        bucketName: string;
        bucketType: "allPrivate" | "allPublic";
        lifecycleRules?: any[];
        corsRules?: unknown[];
        bucketInfo?: {
            [key: string]: unknown;
        };
    }, {
        accountId: string;
        bucketId: string;
        bucketName: string;
        bucketType: "allPrivate" | "allPublic";
        bucketInfo: {
            lifecycleRules: any[];
        };
        corsRules: any[];
        lifecycleRules: any[];
        revision: number;
    }>("b2_create_bucket", "POST");

    const updateBucket = createB2Function<{
        accountId: string;
        bucketId: string;
        bucketType?: "allPrivate" | "allPublic";
        lifecycleRules?: any[];
        bucketInfo?: {
            [key: string]: unknown;
        };
        corsRules?: unknown[];
    }, {
        accountId: string;
        bucketId: string;
        bucketName: string;
        bucketType: "allPrivate" | "allPublic";
        bucketInfo: {
            lifecycleRules: any[];
        };
        corsRules: any[];
        lifecycleRules: any[];
        revision: number;
    }>("b2_update_bucket", "POST");

    // https://www.backblaze.com/apidocs/b2-update-bucket
    //  TODO: b2_update_bucket, so we can update CORS, etc

    const listBuckets = createB2Function<{
        bucketName?: string;
    }, {
        buckets: {
            accountId: string;
            bucketId: string;
            bucketName: string;
            bucketType: "allPrivate" | "allPublic";
            bucketInfo: {
                lifecycleRules: any[];
            };
            corsRules: any[];
            lifecycleRules: any[];
            revision: number;
        }[];
    }>("b2_list_buckets", "POST");

    function encodePath(path: string) {
        // Preserve slashes, but encode everything else
        path = path.split("/").map(encodeURIComponent).join("/");
        if (path.startsWith("/")) path = "%2F" + path.slice(1);
        if (path.endsWith("/")) path = path.slice(0, -1) + "%2F";
        // NOTE: For some reason, this won't render in the web UI correctly. BUT, it'll
        //  work get get/set and find
        //  - ALSO, it seems to add duplicate files? This might also be a web UI thing. It
        //      seems to work though.
        while (path.includes("//")) {
            path = path.replaceAll("//", "/%2F");
        }
        return path;
    }

    async function downloadFileByName(config: {
        bucketName: string;
        fileName: string;
        range?: { start: number; end: number; };
    }) {
        let fileName = encodePath(config.fileName);

        let result = await httpsRequest(auth.apiUrl + "/file/" + config.bucketName + "/" + fileName, Buffer.from(JSON.stringify({
            accountId: auth.accountId,
            responseType: "arraybuffer",
        })), "GET", undefined, {
            headers: Object.fromEntries(Object.entries({
                Authorization: auth.authorizationToken,
                "Content-Type": "application/json",
                Range: config.range ? `bytes=${config.range.start}-${config.range.end - 1}` : undefined,
            }).filter(x => x[1] !== undefined)),
        });
        return result;
    }

    // Oh... apparently, we can't reuse these? Huh...
    const getUploadURL = (async (bucketId: string) => {
        //setTimeout(() => getUploadURL.clear(bucketId), timeInHour * 1);
        let getUploadUrlRaw = await httpsRequest(auth.apiUrl + "/b2api/v2/b2_get_upload_url?bucketId=" + bucketId, undefined, "GET", undefined, {
            headers: {
                Authorization: auth.authorizationToken,
            }
        });

        return JSON.parse(getUploadUrlRaw.toString()) as {
            bucketId: string;
            uploadUrl: string;
            authorizationToken: string;
        };
    });

    async function uploadFile(config: {
        bucketId: string;
        fileName: string;
        data: Buffer;
    }) {
        let getUploadUrl = await getUploadURL(config.bucketId);

        await httpsRequest(getUploadUrl.uploadUrl, config.data, "POST", undefined, {
            headers: {
                Authorization: getUploadUrl.authorizationToken,
                "X-Bz-File-Name": encodePath(config.fileName),
                "Content-Type": "b2/x-auto",
                "X-Bz-Content-Sha1": "do_not_verify",
                "Content-Length": config.data.length + "",
            }
        });
    }

    const hideFile = createB2Function<{
        bucketId: string;
        fileName: string;
    }, {}>("b2_hide_file", "POST", "noAccountId");

    const getFileInfo = createB2Function<{
        bucketName: string;
        fileId: string;
    }, {
        fileId: string;
        fileName: string;
        accountId: string;
        bucketId: string;
        contentLength: number;
        contentSha1: string;
        contentType: string;
        fileInfo: {
            src_last_modified_millis: number;
        };
        action: string;
        uploadTimestamp: number;
    }>("b2_get_file_info", "POST");

    const listFileNames = createB2Function<{
        bucketId: string;
        prefix: string;
        startFileName?: string;
        maxFileCount?: number;
        delimiter?: string;
    }, {
        files: {
            fileId: string;
            fileName: string;
            accountId: string;
            bucketId: string;
            contentLength: number;
            contentSha1: string;
            contentType: string;
            fileInfo: {
                src_last_modified_millis: number;
            };
            action: string;
            uploadTimestamp: number;
        }[];
        nextFileName: string;
    }>("b2_list_file_names", "POST", "noAccountId");

    const copyFile = createB2Function<{
        sourceFileId: string;
        fileName: string;
        destinationBucketId: string;
    }, {}>("b2_copy_file", "POST", "noAccountId");

    const startLargeFile = createB2Function<{
        bucketId: string;
        fileName: string;
        contentType: string;
        fileInfo: { [key: string]: string };
    }, {
        fileId: string;
        fileName: string;
        accountId: string;
        bucketId: string;
        contentType: string;
        fileInfo: any;
        uploadTimestamp: number;
    }>("b2_start_large_file", "POST", "noAccountId");

    // Apparently we can't reuse these?
    const getUploadPartURL = (async (fileId: string) => {
        let uploadPartRaw = await httpsRequest(auth.apiUrl + "/b2api/v2/b2_get_upload_part_url?fileId=" + fileId, undefined, "GET", undefined, {
            headers: {
                Authorization: auth.authorizationToken,
            }
        });
        return JSON.parse(uploadPartRaw.toString()) as {
            fileId: string;
            partNumber: number;
            uploadUrl: string;
            authorizationToken: string;
        };
    });
    async function uploadPart(config: {
        fileId: string;
        partNumber: number;
        data: Buffer;
        sha1: string;
    }): Promise<{
        fileId: string;
        partNumber: number;
        contentLength: number;
        contentSha1: string;
    }> {
        let uploadPart = await getUploadPartURL(config.fileId);

        let result = await httpsRequest(uploadPart.uploadUrl, config.data, "POST", undefined, {
            headers: {
                Authorization: uploadPart.authorizationToken,
                "X-Bz-Part-Number": config.partNumber + "",
                "X-Bz-Content-Sha1": config.sha1,
                "Content-Length": config.data.length + "",

            }
        });
        return JSON.parse(result.toString());
    }

    const finishLargeFile = createB2Function<{
        fileId: string;
        partSha1Array: string[];
    }, {
        fileId: string;
        fileName: string;
        accountId: string;
        bucketId: string;
        contentLength: number;
        contentSha1: string;
        contentType: string;
        fileInfo: any;
        uploadTimestamp: number;
    }>("b2_finish_large_file", "POST", "noAccountId");

    const cancelLargeFile = createB2Function<{
        fileId: string;
    }, {}>("b2_cancel_large_file", "POST", "noAccountId");

    const getDownloadAuthorization = createB2Function<{
        bucketId: string;
        fileNamePrefix: string;
        validDurationInSeconds: number;
        b2ContentDisposition?: string;
        b2ContentLanguage?: string;
        b2Expires?: string;
        b2CacheControl?: string;
        b2ContentEncoding?: string;
        b2ContentType?: string;
    }, {
        bucketId: string;
        fileNamePrefix: string;
        authorizationToken: string;
    }>("b2_get_download_authorization", "POST", "noAccountId");

    async function getDownloadURL(path: string) {
        if (!path.startsWith("/")) {
            path = "/" + path;
        }
        return auth.downloadUrl + path;
    }


    return {
        createBucket,
        updateBucket,
        listBuckets,
        downloadFileByName,
        uploadFile,
        hideFile,
        getFileInfo,
        listFileNames,
        copyFile,
        startLargeFile,
        uploadPart,
        finishLargeFile,
        cancelLargeFile,
        getDownloadAuthorization,
        getDownloadURL,
        apiUrl: auth.apiUrl,
    };
});

type B2Api = (typeof getAPI) extends () => Promise<infer T> ? T : never;


export class ArchivesBackblaze {
    public constructor(private config: {
        bucketName: string;
        public?: boolean;
        immutable?: boolean;
        cacheTime?: number;
    }) { }

    private bucketName = this.config.bucketName.replaceAll(/[^\w\d]/g, "-");
    private bucketId = "";

    private logging = false;
    public enableLogging() {
        this.logging = true;
    }
    private log(text: string) {
        if (!this.logging) return;
        console.log(text);
    }

    public getDebugName() {
        return "backblaze/" + this.config.bucketName;
    }

    private getBucketAPI = lazy(async () => {
        let api = await getAPI();

        let cacheTime = this.config.cacheTime ?? 0;
        if (this.config.immutable) {
            cacheTime = 86400 * 1000;
        }

        // ALWAYS set access control, as we can make urls for private buckets with getDownloadAuthorization
        let desiredCorsRules = [{
            corsRuleName: "allowAll",
            allowedOrigins: ["https"],
            allowedOperations: ["b2_download_file_by_id", "b2_download_file_by_name"],
            allowedHeaders: ["range"],
            exposeHeaders: ["x-bz-content-sha1"],
            maxAgeSeconds: cacheTime / 1000,
        }];
        let bucketInfo: Record<string, unknown> = {};
        if (cacheTime) {
            bucketInfo["cache-control"] = `max-age=${cacheTime / 1000}`;
        }


        let exists = false;
        try {
            await api.createBucket({
                bucketName: this.bucketName,
                bucketType: this.config.public ? "allPublic" : "allPrivate",
                lifecycleRules: [{
                    "daysFromUploadingToHiding": null,
                    // Keep files for 7 days, which should be enough time to recover accidental hiding.
                    "daysFromHidingToDeleting": 7,
                    "fileNamePrefix": ""
                }],
                corsRules: desiredCorsRules,
                bucketInfo
            });
        } catch (e: any) {
            if (!e.stack.includes(`"duplicate_bucket_name"`)) {
                throw e;
            }
            exists = true;
        }

        let bucketList = await api.listBuckets({
            bucketName: this.bucketName,
        });
        if (bucketList.buckets.length === 0) {
            throw new Error(`Bucket name "${this.bucketName}" is being used by someone else. Bucket names have to be globally unique. Try a different name until you find a free one.`);
        }
        this.bucketId = bucketList.buckets[0].bucketId;

        if (exists) {
            let bucket = bucketList.buckets[0];
            function normalize(obj: Record<string, unknown>) {
                let kvps = Object.entries(obj);
                sort(kvps, x => x[0]);
                return Object.fromEntries(kvps);
            }
            function orderIndependentEqual(lhs: Record<string, unknown>, rhs: Record<string, unknown>) {
                return JSON.stringify(normalize(lhs)) === JSON.stringify(normalize(rhs));
            }
            function orderIndependentEqualArray(lhs: unknown[], rhs: unknown[]) {
                if (lhs.length !== rhs.length) return false;
                for (let i = 0; i < lhs.length; i++) {
                    if (!orderIndependentEqual(lhs[i] as Record<string, unknown>, rhs[i] as Record<string, unknown>)) return false;
                }
                return true;
            }
            if (
                !orderIndependentEqualArray(bucket.corsRules, desiredCorsRules)
                || !orderIndependentEqual(bucket.bucketInfo, bucketInfo)
            ) {
                console.log(magenta(`Updating CORS rules for ${this.bucketName}`), bucket.corsRules, desiredCorsRules);
                await api.updateBucket({
                    accountId: bucket.accountId,
                    bucketId: bucket.bucketId,
                    bucketType: bucket.bucketType,
                    lifecycleRules: bucket.lifecycleRules,
                    corsRules: desiredCorsRules,
                    bucketInfo: bucketInfo,
                });
            }
        }
        return api;
    });

    // Keep track of when we last reset because of a 503
    private last503Reset = 0;
    // IMPORTANT! We must always CATCH AROUND the apiRetryLogic, NEVER inside of fnc. Otherwise we won't
    //  be able to recreate the auth token.
    private async apiRetryLogic<T>(
        fnc: (api: B2Api) => Promise<T>,
        retries = 3
    ): Promise<T> {
        let api = await this.getBucketAPI();
        try {
            return await fnc(api);
        } catch (err: any) {
            if (retries <= 0) throw err;

            // If it's a 503 and it's been a minute since we last reset, then Wait and reset. 
            if (
                (err.stack.includes(`503`)
                    || err.stack.includes(`"service_unavailable"`)
                    || err.stack.includes(`"internal_error"`)
                    || err.stack.includes(`ENOBUFS`)
                ) && Date.now() - this.last503Reset > 60 * 1000) {
                console.error("503 error, waiting a minute and resetting: " + err.message);
                this.log("503 error, waiting a minute and resetting: " + err.message);
                await delay(10 * 1000);
                // We check again in case, and in the very likely case that this is being run in parallel, we only want to reset once. 
                if (Date.now() - this.last503Reset > 60 * 1000) {
                    this.log("Resetting getAPI and getBucketAPI: " + err.message);
                    this.last503Reset = Date.now();
                    getAPI.reset();
                    this.getBucketAPI.reset();
                }
                return this.apiRetryLogic(fnc, retries - 1);
            }

            // If the error is that the authorization token is invalid, reset getBucketAPI and getAPI
            // If the error is that the bucket isn't found, reset getBucketAPI
            if (err.stack.includes(`"expired_auth_token"`)) {
                this.log("Authorization token expired");
                getAPI.reset();
                this.getBucketAPI.reset();
                return this.apiRetryLogic(fnc, retries - 1);
            }

            if (
                err.stack.includes(`no tomes available`)
                || err.stack.includes(`ETIMEDOUT`)
                || err.stack.includes(`socket hang up`)
                // Eh... this might be bad, but... I think we just get random 400 errors. If this spams errors,
                //  we can remove this line.
                || err.stack.includes(`400 Bad Request`)
                || err.stack.includes(`getaddrinfo ENOTFOUND`)
                || err.stack.includes(`ECONNRESET`)
                || err.stack.includes(`ECONNREFUSED`)
                || err.stack.includes(`ENOBUFS`)
            ) {
                console.error("Retrying in 5s: " + err.message);
                this.log(err.message + " retrying in 5s");
                await delay(5000);
                return this.apiRetryLogic(fnc, retries - 1);
            }

            if (err.stack.includes(`getaddrinfo ENOTFOUND`)) {
                let urlObj = new URL(api.apiUrl);
                let hostname = urlObj.hostname;
                let lookupAddresses = await new Promise(resolve => {
                    dns.lookup(hostname, (err, addresses) => {
                        resolve(addresses);
                    });
                });
                let resolveAddresses = await new Promise(resolve => {
                    dns.resolve4(hostname, (err, addresses) => {
                        resolve(addresses);
                    });
                });
                console.error(`getaddrinfo ENOTFOUND ${hostname}`, { lookupAddresses, resolveAddresses, apiUrl: api.apiUrl, fullError: err.stack });
            }

            // TODO: Handle if the bucket is deleted?
            throw err;
        }
    }

    public async get(fileName: string, config?: { range?: { start: number; end: number; }; retryCount?: number }): Promise<Buffer | undefined> {
        let downloading = true;
        try {
            let time = Date.now();
            const downloadPoll = () => {
                if (!downloading) return;
                this.log(`Backblaze download in progress ${fileName}`);
                setTimeout(downloadPoll, 5000);
            };
            setTimeout(downloadPoll, 5000);
            let result = await this.apiRetryLogic(async (api) => {
                return await api.downloadFileByName({
                    bucketName: this.bucketName,
                    fileName,
                    range: config?.range
                });
            });
            let timeStr = formatTime(Date.now() - time);
            let rateStr = formatNumber(result.length / (Date.now() - time) * 1000) + "B/s";
            this.log(`backblaze download (${formatNumber(result.length)}B${config?.range && `, ${formatNumber(config.range.start)} - ${formatNumber(config.range.end)}` || ""}) in ${timeStr} (${rateStr}, ${fileName})`);
            return result;
        } catch (e) {
            this.log(`backblaze file does not exist ${fileName}`);
            return undefined;
        } finally {
            downloading = false;
        }
    }
    public async set(fileName: string, data: Buffer): Promise<void> {
        this.log(`backblaze upload (${formatNumber(data.length)}B) ${fileName}`);
        let f = fileName;
        await this.apiRetryLogic(async (api) => {
            await api.uploadFile({ bucketId: this.bucketId, fileName, data: data, });
        });
        let existsChecks = 30;
        while (existsChecks > 0) {
            let exists = await this.getInfo(fileName);
            if (exists) break;
            await delay(1000);
            existsChecks--;
        }
        if (existsChecks === 0) {
            let exists = await this.getInfo(fileName);
            console.warn(`File ${fileName}/${f} was uploaded, but could not be found afterwards. Hopefully it was just deleted, very quickly? If backblaze is taking too long for files to propagate, then we might run into issues with the database atomicity.`);
        }

    }
    public async del(fileName: string): Promise<void> {
        this.log(`backblaze delete ${fileName}`);
        try {
            await this.apiRetryLogic(async (api) => {
                await api.hideFile({ bucketId: this.bucketId, fileName: fileName });
            });
        } catch (e: any) {
            this.log(`backblaze error in hide, possibly already hidden ${fileName}\n${e.stack}`);
        }

        // NOTE: Deletion SEEMS to work. This DOES break if we delete a file which keeps being recreated,
        //  ex, the heartbeat.
        // let existsChecks = 10;
        // while (existsChecks > 0) {
        //     let exists = await this.getInfo(fileName);
        //     if (!exists) break;
        //     await delay(1000);
        //     existsChecks--;
        // }
        // if (existsChecks === 0) {
        //     let exists = await this.getInfo(fileName);
        //     devDebugbreak();
        //     console.warn(`File ${fileName} was deleted, but was still found afterwards`);
        //     exists = await this.getInfo(fileName);
        // }
    }

    public async setLargeFile(config: { path: string; getNextData(): Promise<Buffer | undefined>; }): Promise<void> {

        let onError: (() => Promise<void>)[] = [];
        let time = Date.now();
        try {
            let { path } = config;
            // Backblaze requires 5MB chunks. But, larger is more efficient for us.
            const MIN_CHUNK_SIZE = 32 * 1024 * 1024;
            let dataQueue: Buffer[] = [];
            async function getNextData(): Promise<Buffer | undefined> {
                if (dataQueue.length) return dataQueue.shift();
                // Get buffers until we get 5MB, OR, end. Backblaze requires this for large files.
                let totalBytes = 0;
                let buffers: Buffer[] = [];
                while (totalBytes < MIN_CHUNK_SIZE) {
                    let data = await config.getNextData();
                    if (!data) break;
                    totalBytes += data.length;
                    buffers.push(data);
                }
                if (!buffers.length) return undefined;
                return Buffer.concat(buffers);
            }

            let fileName = path;
            let data = await getNextData();
            if (!data?.length) return;
            // Backblaze disallows overly small files
            if (data.length < MIN_CHUNK_SIZE) {
                return await this.set(fileName, data);
            }
            // Backblaze disallows less than 2 chunks
            let secondData = await getNextData();
            if (!secondData?.length) {
                return await this.set(fileName, data);
            }
            // ALSO, if there are two chunks, but one is too small, combine it. This helps allow us never
            //  send small chunks.
            if (secondData.length < MIN_CHUNK_SIZE) {
                return await this.set(fileName, Buffer.concat([data, secondData]));
            }
            this.log(`Uploading large file ${config.path}`);
            dataQueue.unshift(data, secondData);


            let uploadInfo = await this.apiRetryLogic(async (api) => {
                return await api.startLargeFile({
                    bucketId: this.bucketId,
                    fileName: fileName,
                    contentType: "b2/x-auto",
                    fileInfo: {},
                });
            });
            onError.push(async () => {
                await this.apiRetryLogic(async (api) => {
                    await api.cancelLargeFile({ fileId: uploadInfo.fileId });
                });
            });

            const LOG_INTERVAL = timeInMinute;
            let nextLogTime = Date.now() + LOG_INTERVAL;

            let partNumber = 1;
            let partSha1Array: string[] = [];
            let totalBytes = 0;
            while (true) {
                data = await getNextData();
                if (!data) break;
                // So... if the next chunk is the last one, combine it with the current one. This
                //  prevents ANY uploads from being < the threshold, as apparently the "last part"
                //  check in backblaze fails when we have to retry an upload (due to "no tomes available").
                //  Well it can't fail if even the last part is > 5MB, now can it!
                // BUT, only if this isn't the first chunk, otherwise we might try to send
                //  a single chunk, which we can't do.
                if (partSha1Array.length > 0) {
                    let maybeLastData = await getNextData();
                    if (maybeLastData) {
                        if (maybeLastData.length < MIN_CHUNK_SIZE) {
                            // It's the last one, so consume it now
                            data = Buffer.concat([data, maybeLastData]);
                        } else {
                            // It's not the last one. Put it back, in case the one AFTER is the last
                            //  one, in which case we need to merge maybeLastData with the next next data.
                            dataQueue.unshift(maybeLastData);
                        }
                    }
                }
                let sha1 = require("crypto").createHash("sha1");
                sha1.update(data);
                let sha1Hex = sha1.digest("hex");
                partSha1Array.push(sha1Hex);
                await this.apiRetryLogic(async (api) => {
                    if (!data) throw new Error("Impossible, data is undefined");

                    let timeStr = formatTime(Date.now() - time);
                    let rateStr = formatNumber(totalBytes / (Date.now() - time) * 1000) + "B/s";
                    this.log(`Uploading large file part ${partNumber}, uploaded ${blue(formatNumber(totalBytes) + "B")} in ${blue(timeStr)} (${blue(rateStr)}). ${config.path}`);
                    totalBytes += data.length;

                    await api.uploadPart({
                        fileId: uploadInfo.fileId,
                        partNumber: partNumber,
                        data: data,
                        sha1: sha1Hex,
                    });
                });
                partNumber++;

                if (Date.now() > nextLogTime) {
                    nextLogTime = Date.now() + LOG_INTERVAL;
                    let timeStr = formatTime(Date.now() - time);
                    let rateStr = formatNumber(totalBytes / (Date.now() - time) * 1000) + "B/s";
                    console.log(`Still uploading large file at ${Date.now()}. Uploaded ${formatNumber(totalBytes)}B in ${timeStr} (${rateStr}). ${config.path}`);
                }
            }
            this.log(`Finished uploading large file uploaded ${green(formatNumber(totalBytes))}B`);

            await this.apiRetryLogic(async (api) => {
                await api.finishLargeFile({
                    fileId: uploadInfo.fileId,
                    partSha1Array: partSha1Array,
                });
            });
        } catch (e: any) {
            for (let c of onError) {
                try {
                    await c();
                } catch (e) {
                    console.error(`Error during error clean. Ignoring, we will rethrow the original error, path ${config.path}`, e);
                }
            }

            throw new Error(`Error in setLargeFile for ${config.path}: ${e.stack}`);
        }
    }

    public async getInfo(fileName: string): Promise<{ writeTime: number; size: number; } | undefined> {
        return await this.apiRetryLogic(async (api) => {
            let info = await api.listFileNames({ bucketId: this.bucketId, prefix: fileName, });
            let file = info.files.find(x => x.fileName === fileName);
            if (!file) {
                this.log(`Backblaze file not exists ${fileName}`);
                return undefined;
            }
            this.log(`Backblaze file exists ${fileName}`);
            return {
                writeTime: file.uploadTimestamp,
                size: file.contentLength,
            };
        });
    }

    // For example findFileNames("ips/")
    public async find(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<string[]> {
        let result = await this.findInfo(prefix, config);
        return result.map(x => x.path);
    }
    public async findInfo(prefix: string, config?: { shallow?: boolean; type: "files" | "folders" }): Promise<{ path: string; createTime: number; size: number; }[]> {
        return await this.apiRetryLogic(async (api) => {
            if (!config?.shallow && config?.type === "folders") {
                let allFiles = await this.findInfo(prefix);
                let allFolders = new Map<string, { path: string; createTime: number; size: number }>();
                for (let { path, createTime, size } of allFiles) {
                    let folder = path.split("/").slice(0, -1).join("/");
                    if (!folder) continue;
                    allFolders.set(folder, { path: folder, createTime, size });
                }
                return Array.from(allFolders.values());
            }
            let files = new Map<string, { path: string; createTime: number; size: number; }>();
            let startFileName = "";
            while (true) {
                let result = await api.listFileNames({
                    bucketId: this.bucketId,
                    prefix: prefix,
                    startFileName,
                    maxFileCount: 1000,
                    delimiter: config?.shallow ? "/" : undefined,
                });
                for (let file of result.files) {
                    if (file.action === "upload" && config?.type !== "folders") {
                        files.set(file.fileName, { path: file.fileName, createTime: file.uploadTimestamp, size: file.contentLength });
                    } else if (file.action === "folder" && config?.type === "folders") {
                        let folder = file.fileName;
                        if (folder.endsWith("/")) {
                            folder = folder.slice(0, -1);
                        }
                        files.set(folder, { path: folder, createTime: file.uploadTimestamp, size: file.contentLength });
                    }

                }
                startFileName = result.nextFileName;
                if (!startFileName) break;
            }
            return Array.from(files.values());
        });
    }

    public async assertPathValid(path: string) {
        let bytes = Buffer.from(path, "utf8");
        if (bytes.length > 1000) {
            throw new Error(`Path too long: ${path.length} characters > 1000 characters. Path: ${path}`);
        }
    }

    public async getURL(path: string) {
        return await this.apiRetryLogic(async (api) => {
            if (path.startsWith("/")) {
                path = path.slice(1);
            }
            return await api.getDownloadURL("file/" + this.bucketName + "/" + path);
        });
    }

    public async getDownloadAuthorization(config: {
        fileNamePrefix?: string;
        validDurationInSeconds: number;
        b2ContentDisposition?: string;
        b2ContentLanguage?: string;
        b2Expires?: string;
        b2CacheControl?: string;
        b2ContentEncoding?: string;
        b2ContentType?: string;
    }): Promise<{
        bucketId: string;
        fileNamePrefix: string;
        authorizationToken: string;
    }> {
        return await this.apiRetryLogic(async (api) => {
            return await api.getDownloadAuthorization({
                bucketId: this.bucketId,
                fileNamePrefix: config.fileNamePrefix ?? "",
                ...config,
            });
        });
    }
}

/*
Names should be a UTF-8 string up to 1024 bytes with the following exceptions:
    Character codes below 32 are not allowed.
    DEL characters (127) are not allowed.
    Backslashes are not allowed.
    File names cannot start with /, end with /, or contain //.
*/


export const getArchivesBackblaze = cache((domain: string) => {
    return new ArchivesBackblaze({ bucketName: domain });
});
export const getArchivesBackblazePrivateImmutable = cache((domain: string) => {
    return new ArchivesBackblaze({
        bucketName: domain + "-private-immutable",
        immutable: true
    });
});
export const getArchivesBackblazePublicImmutable = cache((domain: string) => {
    return new ArchivesBackblaze({
        bucketName: domain + "-public-immutable",
        public: true,
        immutable: true
    });
});

// NOTE: Cache by a minute. This might be a bad idea, but... usually whole reason for public is
//  for cloudflare caching (as otherwise we can just access it through a server), or for large files
//  (which should be cached anyways, and probably even use immutable caching).
export const getArchivesBackblazePublic = cache((domain: string) => {
    return new ArchivesBackblaze({
        bucketName: domain + "-public",
        public: true,
        cacheTime: timeInMinute,
    });
});