// Node transport mocks are confined to this process so they cannot affect other suites.
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import * as http from "node:http";
import * as https from "node:https";
import * as dns from "node:dns/promises";
import {mock} from "bun:test";
import type {LookupFunction} from "node:net";

const mode = process.argv[2];
const controller = new AbortController();
const uncaught: Error[] = [];
const captureUncaught = (error: Error) => { uncaught.push(error); };
process.on("uncaughtException", captureUncaught);
const deadlines: Array<() => void> = [];
const realSetTimeout = globalThis.setTimeout;
Reflect.set(globalThis, "setTimeout", (callback: () => void, delay?: number) => {
    if (delay === 30_000) deadlines.push(callback);
    return realSetTimeout(callback, delay);
});
let requests = 0;
let lookups = 0;
let releaseDns: (() => void) | undefined;
const responses: ResponseFixture[] = [];
const clients: RequestFixture[] = [];

class ResponseFixture extends PassThrough {
    headers: Record<string, string> = {"content-type": "text/plain"};
    statusCode = 200;
    statusMessage = "OK";
}

class RequestFixture extends EventEmitter {
    destroyed = false;
    private response?: ResponseFixture;
    private readonly abort = () => this.destroy(new Error("request aborted"));
    constructor(
        private readonly signal: AbortSignal,
        private readonly respond: (response: ResponseFixture) => void
    ) {
        super();
        signal.addEventListener("abort", this.abort, {once: true});
    }
    setTimeout() { return this; }
    destroy(error?: Error) {
        if (this.destroyed) return this;
        this.destroyed = true;
        this.signal.removeEventListener("abort", this.abort);
        this.response?.destroy();
        queueMicrotask(() => {
            if (error) this.emit("error", error);
            this.emit("close");
        });
        return this;
    }
    end() {
        queueMicrotask(() => {
            if (this.destroyed) return;
            if (mode === "request-close") { this.destroy(); return; }
            const response = new ResponseFixture();
            this.response = response;
            responses.push(response);
            if (mode === "declared-limit") response.headers["content-length"] = String(6 * 1024 * 1024);
            if (mode === "invalid-location") { response.statusCode = 302; response.headers.location = "http://["; }
            if ((mode === "redirect" || mode === "redirect-deadline") && requests === 1) {
                response.statusCode = 302;
                response.headers.location = "/next";
            }
            this.respond(response);
            if (mode === "declared-limit") return;
            if (mode === "body-limit") { response.end(Buffer.alloc(6 * 1024 * 1024)); return; }
            if (mode === "response-close") { response.destroy(); return; }
            if (mode === "body-abort") { response.write("partial"); controller.abort(); return; }
            if (mode === "redirect-deadline" && requests === 2) {
                response.write("partial");
                deadlines[0]?.();
                return;
            }
            if (mode === "late-error") response.once("end", () => {
                response.emit("error", new Error("late response error"));
                this.emit("error", new Error("late request error"));
            });
            response.end("complete");
        });
    }
}

const request = (_url: URL, options: {signal: AbortSignal; lookup: LookupFunction}, callback: (response: ResponseFixture) => void) => {
    requests++;
    options.lookup(_url.hostname, {family: 4}, (error, address) => {
        assert.equal(error, null);
        assert.equal(address, "8.8.8.8", "only validated public addresses reach transport");
    });
    const client = new RequestFixture(options.signal, callback);
    clients.push(client);
    return client;
};
mock.module("node:http", () => ({...http, request}));
mock.module("node:https", () => ({...https, request}));
mock.module("node:dns/promises", () => ({...dns, lookup: async () => {
    lookups++;
    if (mode === "dns-abort" || mode === "dns-deadline") {
        await new Promise<void>(resolve => {
            releaseDns = resolve;
            queueMicrotask(() => mode === "dns-abort" ? controller.abort() : deadlines[0]?.());
        });
    }
    if (mode === "dns-reserved") return [{address: "198.18.0.42", family: 4}];
    if (mode === "dns-reserved-v6") return [{address: "::1", family: 6}];
    if (mode === "dns-private") return [{address: "10.0.0.8", family: 4}];
    if (mode === "dns-mixed") return [{address: "198.18.0.42", family: 4}, {address: "8.8.8.8", family: 4}];
    return [{address: "8.8.8.8", family: 4}];
}}));

const {fetchPublicWebUrl} = await import("../../src/tools/webFetch/network.js");
if (mode === "pre-abort") controller.abort();
let watchdogExpired = false;
const watchdog = realSetTimeout(() => {
    watchdogExpired = true;
    controller.abort(new Error("fixture watchdog"));
    releaseDns?.();
}, 300);
let error: unknown;
let body: string | undefined;
try {
    body = (await fetchPublicWebUrl("https://example.com/doc", controller.signal)).body.toString();
} catch (caught) {
    error = caught;
} finally {
    clearTimeout(watchdog);
}
releaseDns?.();
await new Promise<void>(resolve => setImmediate(resolve));
process.removeListener("uncaughtException", captureUncaught);
assert.equal(watchdogExpired, false, "request must settle before the fixture watchdog");
assert.deepEqual(uncaught, [], "response errors must not escape the request Promise");
if (mode === "redirect" || mode === "late-error" || mode === "dns-mixed") {
    assert.equal(error, undefined);
    assert.equal(body, "complete");
} else {
    assert.ok(error instanceof Error, `expected failure for ${mode}`);
    assert.doesNotMatch(error.message, /watchdog/);
    if (mode === "declared-limit" || mode === "body-limit") assert.match(error.message, /byte limit/);
    if (mode === "dns-deadline" || mode === "redirect-deadline") {
        assert.match(error.message, /30000 ms/);
        assert.equal(deadlines.length, 1, "redirects must share one deadline");
    }
    assert.ok(responses.every(response => response.destroyed));
    assert.ok(clients.every(client => client.destroyed));
}
if ((mode?.startsWith("dns-") && mode !== "dns-mixed") || mode === "pre-abort") assert.equal(requests, 0);
if (mode === "pre-abort") assert.equal(lookups, 0);
if (mode === "redirect" || mode === "redirect-deadline") assert.equal(requests, 2);
process.stdout.write("verified\n");
