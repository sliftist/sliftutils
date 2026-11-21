import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { delay } from "socket-function/src/batching";
import { formatTime } from "socket-function/src/formatting/format";

const REGISTRY = "https://registry.npmjs.org";
const NPMRC_PATH = path.join(os.homedir(), ".npmrc");
const TOKEN_PATTERN = /^\/\/registry\.npmjs\.org\/:_authToken=(.+)$/m;
const LOGIN_URL_PATTERN = /https:\/\/www\.npmjs\.com\/login\S*/;
const PUBLISH_SUCCESS_TEXT = "success Published";
const OTP_REQUIRED_PATTERN = /two.factor|one-time|\botp\b|user TTY/i;
const APPROVAL_POLL_FALLBACK = 2000;
const APPROVAL_TIMEOUT = 1000 * 60 * 10;
const MAX_LOGGED_BODY = 500;
const BUMP_FLAGS = ["--patch", "--minor", "--major"];
const CHECK_FLAG = "--check";
const USAGE = `Usage: node D:/repos/sliftutils/bin/publish.js [--patch | --minor | --major] [--cwd <package folder>] [${CHECK_FLAG}]
(yarn release in sliftutils, slift-publish anywhere sliftutils is installed. ${CHECK_FLAG} only reports whether the token is accepted, without opening anything or publishing.)
Publishes the package in the current folder (or --cwd) with yarn publish. npm's two-factor approval is handled here: the approval page opens in the browser, and once it is approved with the security key the publish goes through on its own. Nothing has to be copied back. If the token in ${NPMRC_PATH} is rejected, it logs in through the browser first, which is also just an approval.`;

type RegistryResponse = { status: number; headers: Headers; body: string };

function openInBrowser(url: string) {
    let child = process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.unref();
}

async function run(config: { command: string; cwd: string; onOutput?: (output: string) => void }) {
    let { command, cwd, onOutput } = config;
    console.log(`> ${command}`);
    let child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let onData = (data: Buffer) => {
        let chunk = data.toString();
        output += chunk;
        process.stdout.write(chunk);
        onOutput?.(output);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
    });
    return { code, output };
}

async function readToken(): Promise<string | undefined> {
    let contents: string;
    try {
        contents = await fs.readFile(NPMRC_PATH, "utf8");
    } catch (e) {
        return undefined;
    }
    return TOKEN_PATTERN.exec(contents)?.[1]?.trim() || undefined;
}

async function getUserAgent() {
    let npmVersion = (await run({ command: "npm --version", cwd: process.cwd() })).output.trim().split("\n").pop()?.trim();
    return `npm/${npmVersion} node/${process.version} ${process.platform} ${process.arch} workspaces/false`;
}

async function registryRequest(config: { url: string; method: string; token: string; userAgent: string; body?: string }): Promise<RegistryResponse> {
    let response = await fetch(config.url, {
        method: config.method,
        headers: {
            authorization: `Bearer ${config.token}`,
            "content-type": "application/json",
            "user-agent": config.userAgent,
            "npm-auth-type": "web",
            "npm-command": "dist-tag",
        },
        body: config.body,
    });
    return { status: response.status, headers: response.headers, body: await response.text() };
}

function describeResponse(response: RegistryResponse) {
    return `${response.status}, www-authenticate ${JSON.stringify(response.headers.get("www-authenticate") || "")}, body ${JSON.stringify(response.body.slice(0, MAX_LOGGED_BODY))}`;
}

async function loginThroughBrowser() {
    console.log(`Logging in to ${REGISTRY} through the browser. Approve the login on the page that opens (LastPass has to be enabled for npmjs.com before the passkey shows up).`);
    let opened = false;
    let result = await run({
        command: `npm login --auth-type=web --registry ${REGISTRY}`,
        cwd: process.cwd(),
        onOutput: output => {
            if (opened) return;
            let loginUrl = LOGIN_URL_PATTERN.exec(output)?.[0];
            if (!loginUrl) return;
            opened = true;
            openInBrowser(loginUrl);
            console.log(`Opened ${loginUrl}`);
        },
    });
    if (result.code !== 0) {
        throw new Error(`npm login --auth-type=web exited with code ${result.code}:\n${result.output.slice(-MAX_LOGGED_BODY)}`);
    }
    let token = await readToken();
    if (!token) {
        throw new Error(`npm login finished, but ${NPMRC_PATH} still has no //registry.npmjs.org/:_authToken`);
    }
    return token;
}

async function approveInBrowser(config: { authUrl: string; doneUrl: string; token: string; userAgent: string }) {
    let { authUrl, doneUrl, token, userAgent } = config;
    openInBrowser(authUrl);
    console.log(`Opened ${authUrl}. Approve the publish there with the security key (LastPass has to be enabled for npmjs.com before the passkey shows up). Waiting up to ${formatTime(APPROVAL_TIMEOUT)}.`);
    let deadline = Date.now() + APPROVAL_TIMEOUT;
    while (Date.now() < deadline) {
        let done = await registryRequest({ url: doneUrl, method: "GET", token, userAgent });
        if (done.status === 200) {
            let otp = (JSON.parse(done.body) as { token?: string }).token;
            if (!otp) {
                throw new Error(`Expected ${doneUrl} to return a token once approved, was ${describeResponse(done)}`);
            }
            console.log(`Approved in the browser`);
            return otp;
        }
        if (done.status !== 202) {
            throw new Error(`Expected 200 or 202 polling ${doneUrl}, was ${describeResponse(done)}`);
        }
        let retryAfter = Number(done.headers.get("retry-after")) * 1000;
        await delay(retryAfter > 0 && retryAfter || APPROVAL_POLL_FALLBACK);
    }
    throw new Error(`The publish wasn't approved at ${authUrl} within ${formatTime(APPROVAL_TIMEOUT)}`);
}

async function getOneTimePassword(config: { packageName: string; check?: boolean }): Promise<{ otp?: string; loggedIn?: boolean }> {
    let { packageName, check } = config;
    let userAgent = await getUserAgent();
    let latestResponse = await fetch(`${REGISTRY}/-/package/${encodeURIComponent(packageName).replace("%40", "@")}/dist-tags`);
    if (!latestResponse.ok) {
        console.log(`${packageName} has no dist-tags on ${REGISTRY} (${latestResponse.status}), so it has never been published. Publishing without asking for approval first.`);
        return {};
    }
    let latest = (JSON.parse(await latestResponse.text()) as { latest?: string }).latest;
    if (!latest) {
        throw new Error(`Expected ${packageName} to have a latest dist-tag on ${REGISTRY}, it has none`);
    }
    let probeUrl = `${REGISTRY}/-/package/${encodeURIComponent(packageName).replace("%40", "@")}/dist-tags/latest`;
    let token = await readToken();
    if (!token && check) {
        throw new Error(`${NPMRC_PATH} has no token for ${REGISTRY}`);
    }
    if (!token) {
        console.log(`${NPMRC_PATH} has no token for ${REGISTRY}`);
        await loginThroughBrowser();
        return { loggedIn: true };
    }
    let probe = await registryRequest({ url: probeUrl, method: "PUT", token, userAgent, body: JSON.stringify(latest) });
    if (probe.status >= 200 && probe.status < 300) {
        console.log(`The registry accepted a no-op dist-tag write for ${packageName} without two-factor, so the publish shouldn't need approval`);
        return {};
    }
    let parsed: { authUrl?: string; doneUrl?: string } = {};
    try {
        parsed = JSON.parse(probe.body);
    } catch (e) {
    }
    if (check) {
        console.log(`Check only: the no-op dist-tag write for ${packageName} answered ${describeResponse(probe)}. ${parsed.authUrl && parsed.doneUrl && "The token is accepted and a publish would ask for browser approval." || "The token is NOT accepted for this package, so a publish would log in through the browser first."}`);
        return {};
    }
    if (probe.status === 401 && parsed.authUrl && parsed.doneUrl) {
        return { otp: await approveInBrowser({ authUrl: parsed.authUrl, doneUrl: parsed.doneUrl, token, userAgent }) };
    }
    if (probe.status !== 401) {
        throw new Error(`Expected the no-op dist-tag write ${probeUrl} (latest ${latest}) to ask for two-factor approval (401 with authUrl and doneUrl), was ${describeResponse(probe)}`);
    }
    console.log(`The registry rejected the token in ${NPMRC_PATH} for ${packageName} outright (${describeResponse(probe)}), so it was revoked, expired, or doesn't cover this package. Logging in again.`);
    await loginThroughBrowser();
    return { loggedIn: true };
}

async function main() {
    let args = process.argv.slice(2);
    let cwdIndex = args.indexOf("--cwd");
    let packageDir = path.resolve(cwdIndex >= 0 && args[cwdIndex + 1] || process.cwd());
    let check = args.includes(CHECK_FLAG);
    let bumps = args.filter(arg => BUMP_FLAGS.includes(arg));
    let unknown = args.filter((arg, index) => !BUMP_FLAGS.includes(arg) && arg !== CHECK_FLAG && arg !== "--cwd" && !(cwdIndex >= 0 && index === cwdIndex + 1));
    if (bumps.length > 1 || unknown.length) {
        throw new Error(`Expected at most one of ${BUMP_FLAGS.join(", ")} and an optional --cwd, was ${JSON.stringify(args)}\n${USAGE}`);
    }

    let packageJsonPath = path.join(packageDir, "package.json");
    let originalPackageJson = await fs.readFile(packageJsonPath, "utf8");
    let { name, version } = JSON.parse(originalPackageJson) as { name?: string; version?: string };
    if (!name || !version) {
        throw new Error(`Expected ${packageJsonPath} to have a name and version, was name ${JSON.stringify(name)}, version ${JSON.stringify(version)}`);
    }
    console.log(`Publishing ${name} (currently ${version}${bumps[0] && `, bumping with ${bumps[0]}` || ""}) from ${packageDir}`);

    let publish = async (otp: string | undefined) => {
        let command = `yarn publish --non-interactive --registry ${REGISTRY}${bumps[0] && ` ${bumps[0]}` || ""}${otp && ` --otp ${otp}` || ""}`;
        let result = await run({ command, cwd: packageDir });
        if (result.code === 0 && result.output.includes(PUBLISH_SUCCESS_TEXT)) {
            let published = (JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { version?: string }).version;
            console.log(`Published ${name}@${published}`);
            return { published: true, output: result.output };
        }
        let afterFailure = (JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { version?: string }).version;
        if (afterFailure !== version) {
            await fs.writeFile(packageJsonPath, originalPackageJson);
            console.log(`Put ${packageJsonPath} back from ${afterFailure} to ${version}, so the retry doesn't bump twice`);
        }
        return { published: false, output: result.output, code: result.code };
    };

    let first = await getOneTimePassword({ packageName: name, check });
    if (check) return;
    let result = await publish(first.otp);
    if (result.published) return;
    if (first.loggedIn && OTP_REQUIRED_PATTERN.test(result.output)) {
        console.log(`The fresh login wasn't enough for npm's two-factor on the publish, so asking for approval of the publish itself`);
        let second = await getOneTimePassword({ packageName: name });
        if (second.loggedIn) {
            throw new Error(`The token from the login that just finished was rejected by the registry too, so logging in again would loop`);
        }
        result = await publish(second.otp);
        if (result.published) return;
    }
    throw new Error(`yarn publish of ${name} failed (exit code ${result.code}), see its output above`);
}

main().catch(e => {
    console.error((e as Error).stack ?? e);
    process.exitCode = 1;
});
