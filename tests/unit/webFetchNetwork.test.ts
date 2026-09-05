import {describe, expect, test} from "bun:test";
import {fileURLToPath} from "node:url";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

describe("web_fetch request lifecycle", () => {
    test.each([
        "declared-limit", "body-limit", "invalid-location", "response-close",
        "request-close", "pre-abort", "dns-abort", "dns-deadline", "body-abort",
        "redirect", "redirect-deadline", "late-error",
    ])("%s settles without uncaught errors or leaked requests", async mode => {
        const child = Bun.spawn([
            process.execPath,
            fileURLToPath(new URL("../fixtures/webFetchNetwork.ts", import.meta.url)),
            mode,
        ], {env: testChildEnvironment.base, stdout: "pipe", stderr: "pipe"});
        const [code, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect({code, stdout, stderr}).toEqual({code: 0, stdout: "verified\n", stderr: ""});
    });
});
