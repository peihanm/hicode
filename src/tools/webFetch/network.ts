import {lookup} from "node:dns/promises";
import {request as requestHttp, type ClientRequest, type IncomingMessage} from "node:http";
import {request as requestHttps} from "node:https";
import {BlockList, isIP, type LookupFunction} from "node:net";

const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024;
const WEB_FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

const blockedIpv4Addresses = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const) {
    blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
const blockedIpv6Addresses = new BlockList();
for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["::ffff:0:0", 96],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
] as const) {
    blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

export interface WebFetchResponse {
    url: string;
    status: number;
    statusText: string;
    contentType: string;
    body: Buffer;
    redirectUrl?: string;
}

function normalizedHostname(hostname: string): string {
    return hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

export function parsePublicWebUrl(value: string): URL {
    if (value.length > 2_000) throw new Error("URL must not exceed 2000 characters");
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("Invalid URL format");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only http:// and https:// URLs are supported");
    }
    if (url.username || url.password) {
        throw new Error("URL must not contain a username or password");
    }
    const hostname = normalizedHostname(url.hostname);
    if (
        !hostname ||
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal") ||
        hostname.endsWith(".home.arpa") ||
        (isIP(hostname) === 0 && !hostname.includes("."))
    ) {
        throw new Error("web_fetch can only access the public internet, not localhost or private hosts");
    }
    if (isIP(hostname) !== 0 && !isPublicAddress(hostname)) {
        throw new Error("web_fetch blocks private, loopback, link-local and reserved addresses");
    }
    return url;
}

export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    // Bun's node:net BlockList compatibility can treat an IPv4 check against
    // a mixed IPv4/IPv6 list as blocked unexpectedly, so keep families apart.
    if (family === 4) return !blockedIpv4Addresses.check(address, "ipv4");
    if (family === 6) return !blockedIpv6Addresses.check(address, "ipv6");
    return false;
}

async function resolvePublicAddresses(hostname: string) {
    const normalized = normalizedHostname(hostname);
    if (isIP(normalized) !== 0) {
        if (!isPublicAddress(normalized)) {
            throw new Error("Target resolves to a private, loopback, link-local or reserved address");
        }
        return [{address: normalized, family: isIP(normalized) as 4 | 6}];
    }
    const addresses = await lookup(normalized, {all: true, order: "verbatim"});
    if (addresses.length === 0) throw new Error(`Cannot resolve domain: ${normalized}`);
    // CDNs, corporate DNS and local proxies may return both public and reserved addresses.
    // Filter inaccessible results and pin to remaining public addresses; deny only if none remain.
    // This avoids rejecting public sites while ensuring requests never connect to private addresses.
    const publicAddresses = addresses.filter(({address}) => isPublicAddress(address));
    if (publicAddresses.length === 0) {
        throw new Error("Target domain resolves to a private, loopback, link-local or reserved address");
    }
    return publicAddresses;
}

function createPinnedLookup(
    addresses: Awaited<ReturnType<typeof resolvePublicAddresses>>
): LookupFunction {
    return (_hostname, options, callback) => {
        const requestedFamily = typeof options.family === "number"
            ? options.family
            : options.family === "IPv4"
                ? 4
                : options.family === "IPv6"
                    ? 6
                    : 0;
        const candidates = requestedFamily === 0
            ? addresses
            : addresses.filter(({family}) => family === requestedFamily);
        if (candidates.length === 0) {
            callback(Object.assign(new Error("No public IP matches the requested address family"), {code: "ENOTFOUND"}), "", 0);
            return;
        }
        if (options.all) callback(null, candidates);
        else callback(null, candidates[0]!.address, candidates[0]!.family);
    };
}

function requestAbortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error("Web request cancelled");
}

// DNS lookup cannot be cancelled, but its late result must never start a request.
async function resolveWithAbort(hostname: string, signal: AbortSignal) {
    if (signal.aborted) throw requestAbortError(signal);
    return new Promise<Awaited<ReturnType<typeof resolvePublicAddresses>>>((resolve, reject) => {
        const abort = () => reject(requestAbortError(signal));
        signal.addEventListener("abort", abort, {once: true});
        resolvePublicAddresses(hostname).then(resolve, reject).finally(() => {
            signal.removeEventListener("abort", abort);
        });
    });
}

async function requestOnce(url: URL, signal: AbortSignal): Promise<WebFetchResponse> {
    const addresses = await resolveWithAbort(url.hostname, signal);
    if (signal.aborted) throw requestAbortError(signal);
    const request = url.protocol === "https:" ? requestHttps : requestHttp;
    return new Promise((resolve, reject) => {
        let req: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        let settled = false;
        const chunks: Buffer[] = [];
        const cleanup = () => {
            signal.removeEventListener("abort", abort);
            chunks.length = 0;
        };
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            // Keep error listeners until disposal: destroy/late transport events can emit again.
            response?.destroy();
            req?.destroy();
            reject(error);
        };
        const abort = () => fail(requestAbortError(signal));
        signal.addEventListener("abort", abort, {once: true});
        try {
            req = request(url, {
                method: "GET",
                headers: {
                    Accept: "text/markdown, text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1",
                    "User-Agent": "pillar-agent/0.1 web_fetch",
                },
                lookup: createPinnedLookup(addresses),
                signal,
            }, (incoming) => {
                response = incoming;
                response.on("error", fail);
                response.on("aborted", () => fail(new Error("Web response was interrupted before completion")));
                response.on("close", () => {
                    if (!settled) fail(new Error("Web response closed before completion"));
                });
                if (settled) { response.destroy(); return; }
                let bytes = 0;
                const declaredLength = Number(response.headers["content-length"] ?? 0);
                if (Number.isFinite(declaredLength) && declaredLength > WEB_FETCH_MAX_BYTES) {
                    fail(new Error(`Response exceeds the ${WEB_FETCH_MAX_BYTES} byte limit`));
                    return;
                }
                response.on("data", (chunk: Buffer | string) => {
                    if (settled) return;
                    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    bytes += buffer.length;
                    if (bytes > WEB_FETCH_MAX_BYTES) {
                        fail(new Error(`Response exceeds the ${WEB_FETCH_MAX_BYTES} byte limit`));
                        return;
                    }
                    chunks.push(buffer);
                });
                response.on("end", () => {
                    if (settled) return;
                    try {
                        const result: WebFetchResponse = {
                            url: url.toString(),
                            status: incoming.statusCode ?? 0,
                            statusText: incoming.statusMessage ?? "",
                            contentType: String(incoming.headers["content-type"] ?? ""),
                            body: Buffer.concat(chunks),
                            ...(incoming.headers.location
                                ? {redirectUrl: new URL(incoming.headers.location, url).toString()}
                                : {}),
                        };
                        settled = true;
                        cleanup();
                        resolve(result);
                    } catch (error) {
                        fail(error instanceof Error ? error : new Error(String(error)));
                    }
                });
            });
            req.on("error", fail);
            req.on("close", () => {
                if (!response) fail(new Error("Web request closed before a response was received"));
            });
            req.end();
        } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

export async function fetchPublicWebUrl(
    value: string,
    signal: AbortSignal
): Promise<WebFetchResponse> {
    if (signal.aborted) throw requestAbortError(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(requestAbortError(signal));
    signal.addEventListener("abort", abort, {once: true});
    const deadline = setTimeout(() => {
        controller.abort(new Error(`Request did not complete within ${WEB_FETCH_TIMEOUT_MS} ms`));
    }, WEB_FETCH_TIMEOUT_MS);
    deadline.unref?.();
    try {
        let current = parsePublicWebUrl(value);
        for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
            const response = await requestOnce(current, controller.signal);
            if (response.status < 300 || response.status >= 400 || !response.redirectUrl) {
                return response;
            }
            const next = parsePublicWebUrl(response.redirectUrl);
            if (next.origin !== current.origin) {
                return response;
            }
            current = next;
        }
        throw new Error(`Redirect count exceeds ${MAX_REDIRECTS} attempts`);
    } finally {
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
    }
}
