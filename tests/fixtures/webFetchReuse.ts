import assert from "node:assert/strict";
import {mock} from "bun:test";
import * as network from "../../src/tools/webFetch/network.js";
import {webFetchFailure} from "../../src/tools/webFetch/errors.js";
import {contentText} from "../../src/images/content.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

const mode = process.argv[2];
let calls = 0;
mock.module("../../src/tools/webFetch/network.js", () => ({...network, fetchPublicWebUrl: async (url: string) => {
    calls++;
    if (mode === "failure") throw webFetchFailure("request", Object.assign(new Error("fixture certificate error"), {code: "CERT_HAS_EXPIRED"}), new URL(url), 7);
    return {url, attempts: 1, status: mode === "http-error" ? 429 : 200, statusText: "Fixture",
        cacheControl: mode === "no-store" ? "no-store" : "",
        contentType: ["octet", "binary", "invalid-utf8"].includes(mode ?? "") ? "application/octet-stream" : "text/plain",
        body: mode === "binary" ? Buffer.from([0, 1, 2]) : mode === "invalid-utf8" ? Buffer.from([0xff, 0xfe, 0xfd]) : Buffer.from("--- a/source\n+++ b/source\n+valid text\n")};
}}));
const {executeToolResult} = await import("../helpers/executeTool.js");
await withTempProject(async cwd => {
    if (mode?.startsWith("open")) {
        let prompts = 0, reviews = 0;
        const sandbox = {...createDisabledSandboxRuntime(), status: {kind: "ready" as const, platform: "macos" as const, networkMode: "open" as const, warnings: []}};
        const ctx = createTestContext(cwd, {permissionMode: mode === "open-auto" ? "auto-review" : "ask",
            shellRunner: createShellRunner(sandbox, testChildEnvironment),
            canUseTool: async () => {prompts++; return {behavior: "deny", message: "fixture"};}});
        ctx.approvalReviewer = async () => {reviews++; return {decision: "deny", risk: "low", reason: "fixture"};};
        if (mode === "open-ask") ctx.permissionRules.ask.push({toolName: "web_fetch", source: "host"});
        if (mode === "open-deny") ctx.permissionRules.deny.push({toolName: "web_fetch", source: "host"});
        const result = await executeToolResult("web_fetch", JSON.stringify({url: "https://docs.example.com/source"}), ctx, "open-fetch");
        const allowed = mode === "open" || mode === "open-auto";
        assert.equal(result.outcome, allowed ? "ok" : "denied");
        assert.equal(calls, allowed ? 1 : 0);
        assert.equal(prompts, mode === "open-ask" ? 1 : 0);
        assert.equal(reviews, 0);
        return;
    }
    const ctx = createTestContext(cwd);
    const url = "https://docs.example.com/source?version=1";
    const invoke = (args = {}, context = ctx) => executeToolResult("web_fetch", JSON.stringify({url, ...args}), context, `fetch-${calls}`);
    if (mode === "pinned-private" || mode === "pinned-http" || mode === "pinned-denied") {
        if (mode === "pinned-denied") ctx.permissionRules.deny.push({toolName: "web_fetch", content: "domain:docs.example.com", source: "host"});
        const result = await invoke({resolved_addresses: mode === "pinned-private" ? ["127.0.0.1"] : ["8.8.8.8"],
            ...(mode === "pinned-http" ? {url: "http://docs.example.com/source"} : {})});
        assert.notEqual(result.outcome, "ok");
        assert.equal(calls, 0, "invalid DNS overrides and domain denials must never reach the transport");
        return;
    }
    const first = await invoke();
    if (mode === "binary" || mode === "invalid-utf8") {
        assert.equal(first.outcome, "failed");
        assert.match(contentText(first.modelContent), /Unsupported response type/);
        assert.equal(calls, 1);
    } else if (mode === "failure" || mode === "http-error") {
        const second = await invoke();
        assert.equal(second.outcome, "failed");
        assert.match(contentText(second.modelContent), /failed 2 time\(s\) in this turn/);
        if (mode === "failure") assert.match(contentText(second.modelContent), /CERT_HAS_EXPIRED/);
        else assert.match(contentText(second.modelContent), /HTTP: 429/);
        const nextTurn = createTestContext(cwd, {webSources: ctx.webSources, toolResultStore: ctx.toolResultStore});
        const third = await invoke({}, nextTurn);
        assert.match(contentText(third.modelContent), /failed 1 time\(s\) in this turn/);
        assert.equal(calls, 3);
    } else {
        assert.equal(first.outcome, "ok");
        assert.ok(first.persisted);
        if (mode === "permission") ctx.permissionRules.deny.push({toolName: "web_fetch", content: "domain:docs.example.com", source: "host"});
        if (mode === "expired") ctx.webSources.remember(url, first.persisted, "fixture", 0);
        if (mode === "evicted") await ctx.toolResultStore.removeArtifact(first.persisted.resultId);
        const second = await invoke(mode === "refresh" ? {refresh: true} : mode === "query" ? {url: "https://docs.example.com/source?version=2"} : {});
        if (mode === "permission") {assert.equal(second.outcome, "denied"); assert.equal(calls, 1);}
        else {
            assert.equal(second.outcome, "ok");
            const reused = !["refresh", "query", "no-store", "expired", "evicted"].includes(mode ?? "");
            assert.equal(calls, reused ? 1 : 2);
            if (reused) {
                assert.match(contentText(second.modelContent), /Reused the complete response/);
                assert.equal(second.persisted?.resultId, first.persisted.resultId);
            }
        }
    }
});
process.stdout.write("verified\n");
