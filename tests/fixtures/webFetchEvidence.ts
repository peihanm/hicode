import {contentText} from "../../src/images/content.js";
import assert from "node:assert/strict";
import {mock} from "bun:test";
import * as network from "../../src/tools/webFetch/network.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";

const mode = process.argv[2];
const body = `${"文档正文\n".repeat(11_000)}MIDDLEAPICONTRACT${"文档正文\n".repeat(11_000)}TAILAPICONTRACT`;
let calls = 0;
mock.module("../../src/tools/webFetch/network.js", () => ({
    ...network,
    fetchPublicWebUrl: async () => {
        calls++;
        return {url: "https://example.com/docs", status: mode === "http-error" ? 500 : 200,
            statusText: "Fixture", contentType: "text/html", body: Buffer.from(`<p>${body}</p>`)};
    },
}));
const {executeToolResult} = await import("../helpers/executeTool.js");
await withTempProject(async cwd => {
    const store = createTestToolResultStore(cwd, "web", {
        ...(mode === "save-failure" ? {maxSessionBytes: 0} : {}),
    });
    const ctx = createTestContext(cwd, {toolResultStore: store});
    const result = await executeToolResult("web_fetch", JSON.stringify({
        url: "https://example.com/docs", ...(mode === "maximum" ? {max_chars: 100_000} : {}),
    }), ctx, "web-call");
    assert.equal(result.outcome, mode === "http-error" ? "failed" : "ok");
    assert.ok(!contentText(result.modelContent).includes("MIDDLEAPICONTRACT"));
    if (mode === "save-failure") {
        assert.equal(result.persisted, undefined);
        assert.match(contentText(result.modelContent), /complete result could not be saved/);
    } else {
        assert.match(contentText(result.modelContent), /TAILAPICONTRACT/);
        assert.ok(result.persisted, "long normalized body must be persisted");
        assert.equal(result.persisted.complete, true);
        assert.ok(result.modelContent.length <= store.previewChars + 1000, "persisted references must keep the shared bounded preview");
        const tail = await executeToolResult("read_file", JSON.stringify({
            path: result.persisted.path, offset: 1,
        }), ctx, "read-tail");
        assert.equal(tail.outcome, "ok");
        assert.match(contentText(tail.modelContent), /TAILAPICONTRACT/);
    }
    assert.equal(calls, 1);
});
process.stdout.write("verified\n");
